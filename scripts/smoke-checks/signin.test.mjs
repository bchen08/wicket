import { describe, expect, it } from "vitest";
import { fakeSigninServer } from "./signin-fake.mjs";
import { runSigninChecks, SMOKE_PHONE } from "./signin.mjs";

// The connector sign-in smoke checks against a fake sign-in server: they pass on a working one, fail with
// evidence on a broken one, and write nothing where writes aren't allowed.

const BASE = "https://emergent-git-claude-signin.vercel.app";
const SLOT = { start: "2026-11-10T10:00:00-05:00", display: "Tue 10 Nov, 10:00" };

class Failed extends Error {}

/** Run the checks with a minimal runner, like runSmoke's: rows of { item, result, evidence }. */
async function run({ breaks = null, writesAllowed = true } = {}) {
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
  await runSigninChecks({
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
    writesAllowed,
    agent: "front-desk-smoke",
    customerName: "Smoke Test",
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

  it("only reads where writes aren't allowed: S5–S7 are skipped, nothing is registered or signed in", async () => {
    const { rows, requests } = await run({ writesAllowed: false });
    expect(rows.map((r) => r.result)).toEqual(["PASS", "PASS", "PASS", "PASS", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(requests.some((r) => r.method === "POST" && r.path.startsWith("/api/oauth/"))).toBe(false);
  });
});
