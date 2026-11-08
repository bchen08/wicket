import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import signin, { SMOKE_PHONE } from "./signin.mjs";

// The connector sign-in smoke checks against a fake sign-in server: they pass on a working one, fail with
// evidence on a broken one, and write nothing where writes aren't allowed.

const BASE = "https://emergent-git-claude-signin.vercel.app";
const SLOT = { start: "2026-11-10T10:00:00-05:00", display: "Tue 10 Nov, 10:00" };

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A fake sign-in server on `baseUrl`. `breaks` turns one behavior off to make a check fail:
 * "metadata" (the issuer is wrong), "challenge" (anonymous list_my_bookings answers 200), "name" (a signed-in
 * book keeps the agent's missing name as "unknown").
 */
function fakeSigninServer({ baseUrl, breaks = null }) {
  const state = { clients: new Map(), codes: new Map(), tokens: new Map(), bookings: [], customer: null };
  let n = 0;

  const toolResult = (structuredContent) => ({ content: [{ type: "text", text: "ok" }], structuredContent });
  const rpc = (id, result) => json({ jsonrpc: "2.0", id, result });

  /** Answer the request, or undefined to leave it to the caller's fake. */
  async function handle(url, init, headers) {
    const method = init.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && path === "/.well-known/oauth-protected-resource/api/mcp") {
      return json({ resource: `${baseUrl}/api/mcp`, authorization_servers: [breaks === "metadata" ? "https://elsewhere.example" : baseUrl] });
    }
    if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
        token_endpoint: `${baseUrl}/api/oauth/token`,
        registration_endpoint: `${baseUrl}/api/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (method === "POST" && path === "/api/oauth/register") {
      const body = JSON.parse(init.body);
      const clientId = `fd_client_${++n}`;
      state.clients.set(clientId, { name: body.client_name, redirectUris: body.redirect_uris });
      return json({ client_id: clientId, redirect_uris: body.redirect_uris }, 201);
    }
    if (method === "GET" && path === "/api/oauth/authorize") {
      const client = state.clients.get(url.searchParams.get("client_id"));
      if (!client || !client.redirectUris.includes(url.searchParams.get("redirect_uri"))) {
        return new Response("Front Desk can't sign you in.\n\nUnknown client_id.", { status: 400 });
      }
      return new Response(null, { status: 302, headers: { location: `${baseUrl}/signin?${url.searchParams}` } });
    }
    if (method === "GET" && path === "/signin") {
      const client = state.clients.get(url.searchParams.get("client_id"));
      return new Response(`<h1>${client?.name ?? "?"} wants to book for you</h1>`, { headers: { "content-type": "text/html" } });
    }
    if (method === "POST" && path === "/api/oauth/authorize") {
      const form = new URLSearchParams(init.body);
      const code = `fdc_${++n}`;
      state.customer = { name: form.get("name"), phone: form.get("phone").replace(/\s/g, "") };
      state.codes.set(code, { challenge: form.get("code_challenge"), clientId: form.get("client_id") });
      const back = new URL(form.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", form.get("state"));
      back.searchParams.set("iss", baseUrl);
      return new Response(null, { status: 303, headers: { location: back.toString() } });
    }
    if (method === "POST" && path === "/api/oauth/token") {
      const form = new URLSearchParams(init.body);
      const issue = () => {
        const access = `fda_${++n}`;
        state.tokens.set(access, true);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: `fdr_${n}`, scope: "bookings" });
      };
      if (form.get("grant_type") === "refresh_token") return form.get("refresh_token")?.startsWith("fdr_") ? issue() : json({ error: "invalid_grant" }, 400);
      const code = state.codes.get(form.get("code"));
      state.codes.delete(form.get("code"));
      const verified = code && createHash("sha256").update(form.get("code_verifier")).digest("base64url") === code.challenge;
      return verified ? issue() : json({ error: "invalid_grant" }, 400);
    }
    if (method === "POST" && path === "/api/mcp") {
      const message = JSON.parse(init.body);
      const name = message.params?.name;
      const token = headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token) {
        if (name !== "list_my_bookings" || breaks === "challenge") return undefined;
        return json(
          { error: "invalid_token" },
          401,
          { "www-authenticate": `Bearer error="invalid_token", scope="bookings", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/mcp"` },
        );
      }
      if (!state.tokens.has(token)) return json({ error: "invalid_token" }, 401);
      const args = message.params.arguments ?? {};
      if (name === "book") {
        const booking = {
          id: `signed-in-${++n}`,
          status: "awaiting_approval",
          start: args.start,
          customer: { displayName: args.customer_name ?? (breaks === "name" ? "unknown" : state.customer.name), approved: false, phone: state.customer.phone },
        };
        state.bookings.push(booking);
        return rpc(message.id, toolResult({ booking }));
      }
      if (name === "list_my_bookings") {
        return rpc(message.id, toolResult({ customer: state.customer, bookings: state.bookings, truncated: false }));
      }
      if (name === "cancel") {
        const booking = state.bookings.find((b) => b.id === args.booking_id);
        booking.status = "cancelled";
        return rpc(message.id, toolResult({ booking, depositEffect: "none", depositCollected: false }));
      }
      return undefined;
    }
    return undefined;
  }

  return { handle, state };
}

class Failed extends Error {}

/** Run the checks with a minimal runner, like runSmoke's: rows of { item, result, evidence }. */
async function run({ breaks = null, writesAllowed = true, texting = "off" } = {}) {
  const server = fakeSigninServer({ baseUrl: BASE, breaks });
  const requests = [];
  const client = {
    async request(path, init = {}) {
      const url = new URL(path, BASE);
      const headers = new Headers(init.headers);
      requests.push({ path: url.pathname, method: init.method ?? "GET", headers });
      let res = await server.handle(url, init, headers);
      // What the sign-in fake leaves to the rest of the deployment: an anonymous get_availability (and anything else).
      if (!res && url.pathname === "/api/mcp") {
        const message = JSON.parse(init.body);
        const anonymous = message.params?.name === "list_my_bookings"
          ? { content: [{ type: "text", text: "ok" }], structuredContent: { customer: null, bookings: [] } }
          : { content: [{ type: "text", text: "ok" }], structuredContent: { slots: [SLOT], truncated: false } };
        res = Response.json({ jsonrpc: "2.0", id: message.id, result: anonymous });
      }
      res ??= new Response("not found", { status: 404 });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: res.headers, text, json };
    },
  };
  const rows = [];
  await signin({
    async check(item, title, body) {
      try {
        const out = await body();
        rows.push(out && typeof out === "object" && "skipped" in out ? { item, result: "SKIPPED", evidence: out.skipped } : { item, result: "PASS", evidence: out });
      } catch (err) {
        rows.push({ item, result: "FAIL", evidence: err instanceof Failed ? err.message : `error: ${err.message}` });
      }
    },
    expect(ok, evidence) {
      if (!ok) throw new Failed(evidence);
    },
    client,
    http: (res) => `HTTP ${res.status} ${res.text.slice(0, 80)}`,
    snippet: (text, max = 140) => String(text).slice(0, max),
    baseUrl: BASE,
    status: { texting, database: { writesAllowed } },
    SMOKE_AGENT: "front-desk-smoke",
    SMOKE_CUSTOMER: "Smoke Test",
    now: () => Date.parse("2026-11-08T12:00:00Z"),
    random: () => 0,
  });
  return { rows, server, requests };
}

describe("connector sign-in smoke checks", () => {
  it("pass on a working server: discovery, the 401 challenge, sign-in, a signed-in booking without a name, refresh", async () => {
    const { rows, server } = await run();
    expect(rows.map((r) => [r.item, r.result])).toEqual([
      ["S1", "PASS"],
      ["S2", "PASS"],
      ["S3", "PASS"],
      ["S4", "PASS"],
      ["S5", "PASS"],
      ["S6", "PASS"],
      ["S7", "PASS"],
    ]);
    expect(server.state.customer).toEqual({ name: "Smoke Test", phone: SMOKE_PHONE });
    // The signed-in booking was booked for the customer and cancelled again.
    expect(server.state.bookings.map((b) => [b.customer.displayName, b.status])).toEqual([["Smoke Test", "cancelled"]]);
    expect(rows.find((r) => r.item === "S6").evidence).toMatch(/booked for Smoke Test \(\+12025550143\), listed among 1, cancelled/);
  });

  it("fail with evidence on a broken server", async () => {
    expect((await run({ breaks: "metadata" })).rows.find((r) => r.item === "S1")).toMatchObject({
      result: "FAIL",
      evidence: expect.stringContaining("https://elsewhere.example"),
    });
    expect((await run({ breaks: "challenge" })).rows.find((r) => r.item === "S3")).toMatchObject({ result: "FAIL", evidence: expect.stringContaining("HTTP 200") });
    const named = await run({ breaks: "name" });
    expect(named.rows.find((r) => r.item === "S6")).toMatchObject({ result: "FAIL", evidence: expect.stringContaining("booked for unknown") });
    // Even after the failed check, the booking isn't left held: the cleanup cancel ran (here, anonymously).
    expect(named.requests.filter((r) => r.path === "/api/mcp").length).toBeGreaterThan(0);
  });

  it("skips the signed-in booking where texting is on: it would text the number", async () => {
    const { rows, server } = await run({ texting: "twilio" });
    expect(rows.find((r) => r.item === "S6")).toMatchObject({ result: "SKIPPED", evidence: expect.stringContaining("texting is twilio") });
    expect(server.state.bookings).toEqual([]);
  });

  it("only reads where writes aren't allowed: S5–S7 are skipped, nothing is registered or signed in", async () => {
    const { rows, requests } = await run({ writesAllowed: false });
    expect(rows.map((r) => r.result)).toEqual(["PASS", "PASS", "PASS", "PASS", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(requests.some((r) => r.method === "POST" && r.path.startsWith("/api/oauth/"))).toBe(false);
  });
});
