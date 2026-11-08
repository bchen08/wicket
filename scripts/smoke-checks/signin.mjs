// pnpm smoke feature check: connector sign-in (SMOKE.md → "Connector sign-in", docs/connector-signin.md).
// Loaded by scripts/smoke.mjs.
//
// Read-only, everywhere:
//   S1 protected resource metadata for /api/mcp names this deployment as the issuer
//   S2 authorization server metadata: code + PKCE S256, Client ID Metadata Documents, registration
//   S3 an anonymous list_my_bookings gets the 401 sign-in challenge pointing at that metadata
//   S4 an unknown client gets an error page, never a redirect
// Writes, only where /api/status says writesAllowed:
//   S5 sign in as a test client: register → authorize → the /signin form → code → tokens (PKCE)
//   S6 signed in, book without customer_name books as the customer; list_my_bookings lists it; cancel it
//   S7 the refresh token gets a new access token that works
// The booking S6 makes is cancelled, even after a failure. S5–S7 are SKIPPED where texting is on: signing in
// would text a number and wait for the code.

import { createHash, randomBytes } from "node:crypto";

/** The smoke run's customer: a fictional 555-01xx number, signed in again (the same customer) every run. */
export const SMOKE_PHONE = "+12025550143";
/** The redirect URI the smoke client registers. Never fetched: the code is read from the Location header. */
export const SMOKE_REDIRECT = "https://front-desk-smoke.invalid/callback";
const MCP_MODERN = "2026-07-28";
const DAY_MS = 24 * 60 * 60 * 1000;

const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");

/** @param {any} ctx the feature-check context from runSmoke */
export default async function signin(ctx) {
  const { check, expect, client, http, snippet, baseUrl, status, now, random, SMOKE_AGENT: agent, SMOKE_CUSTOMER: customerName } = ctx;
  const writesAllowed = status.database?.writesAllowed === true;
  const texting = status.texting === "photon" || status.texting === "twilio";
  const resourceMetadata = `${baseUrl}/.well-known/oauth-protected-resource/api/mcp`;

  let nextId = 1;
  /** A tools/call to /api/mcp, with a bearer token or none: { status, headers, result }. */
  async function callTool(name, args, token) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_MODERN,
      "mcp-method": "tools/call",
      "mcp-name": name,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const params = {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: agent, version: "1.0.0" },
      },
    };
    const res = await client.request("/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params }),
    });
    let message = res.json;
    if (!message) {
      const data = res.text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      try {
        message = JSON.parse(data);
      } catch {
        message = undefined;
      }
    }
    return { ...res, result: message?.result };
  }

  /** A signed-in tool call that must succeed: its structuredContent, or a failed check. */
  async function signedIn(name, args, token) {
    const res = await callTool(name, args, token);
    expect(res.status === 200 && res.result && !res.result.isError, `${name}: ${http(res)}`);
    return res.result.structuredContent;
  }

  await check("S1", "Protected resource metadata for /api/mcp names this deployment as the issuer", async () => {
    const res = await client.request("/.well-known/oauth-protected-resource/api/mcp");
    const m = res.json;
    expect(res.status === 200 && m, http(res));
    const evidence = `resource ${m.resource}, authorization_servers ${JSON.stringify(m.authorization_servers)}`;
    expect(m.resource === `${baseUrl}/api/mcp` && m.authorization_servers?.[0] === baseUrl, evidence);
    return evidence;
  });

  await check("S2", "Authorization server metadata: code + PKCE S256, Client ID Metadata Documents, registration", async () => {
    const res = await client.request("/.well-known/oauth-authorization-server");
    const m = res.json;
    expect(res.status === 200 && m, http(res));
    const evidence =
      `issuer ${m.issuer}, PKCE ${JSON.stringify(m.code_challenge_methods_supported)}, ` +
      `CIMD ${m.client_id_metadata_document_supported}, auth ${JSON.stringify(m.token_endpoint_auth_methods_supported)}`;
    expect(
      m.issuer === baseUrl &&
        m.authorization_endpoint === `${baseUrl}/api/oauth/authorize` &&
        m.token_endpoint === `${baseUrl}/api/oauth/token` &&
        m.registration_endpoint === `${baseUrl}/api/oauth/register` &&
        m.code_challenge_methods_supported?.includes("S256") &&
        m.client_id_metadata_document_supported === true &&
        m.token_endpoint_auth_methods_supported?.includes("none"),
      evidence,
    );
    return evidence;
  });

  await check("S3", "Anonymous list_my_bookings → 401 pointing at the metadata (the client's sign-in step)", async () => {
    const res = await callTool("list_my_bookings", {});
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(res.status === 401, http(res));
    expect(challenge.includes(`resource_metadata="${resourceMetadata}"`), `WWW-Authenticate: ${snippet(challenge)}`);
    return `401, WWW-Authenticate: ${snippet(challenge, 90)}`;
  });

  await check("S4", "An unknown client gets an error page, not a redirect", async () => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: `${agent}-unknown-client`,
      redirect_uri: SMOKE_REDIRECT,
      code_challenge: s256("x"),
      code_challenge_method: "S256",
    });
    const res = await client.request(`/api/oauth/authorize?${query}`);
    expect(res.status === 400 && !res.headers.get("location"), http(res));
    return `400: ${snippet(res.text, 80)}`;
  });

  if (!writesAllowed) {
    for (const [item, title] of [
      ["S5", "Sign in as a test client (register → authorize → /signin → tokens)"],
      ["S6", "Signed in: book without a name books as the customer; list_my_bookings; cancel"],
      ["S7", "Refresh: a new access token that works"],
    ]) {
      await check(item, title, async () => ({ skipped: "writesAllowed is false: this deployment's data isn't for tests" }));
    }
    return;
  }

  /** What S5 signed in with. */
  const session = {};

  await check("S5", "Sign in as a test client (register → authorize → /signin → tokens)", async () => {
    if (texting) return { skipped: `texting is ${status.texting}: signing in would text the number and wait for the code` };
    const reg = await client.request("/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: agent, redirect_uris: [SMOKE_REDIRECT] }),
    });
    expect(reg.status === 201 && typeof reg.json?.client_id === "string", `register: ${http(reg)}`);
    const clientId = reg.json.client_id;

    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(8).toString("hex");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: SMOKE_REDIRECT,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      state,
      scope: "bookings",
      resource: `${baseUrl}/api/mcp`,
    });
    const start = await client.request(`/api/oauth/authorize?${query}`);
    const signin = start.headers.get("location") ?? "";
    expect(start.status === 302 && signin.startsWith(`${baseUrl}/signin?`), `authorize: HTTP ${start.status} → ${signin || "(no Location)"}`);

    const page = await client.request(new URL(signin).pathname + new URL(signin).search);
    expect(page.status === 200 && page.text.includes(agent), `/signin: HTTP ${page.status}, doesn't name ${agent}`);

    const form = new URLSearchParams(new URL(signin).searchParams);
    form.set("name", customerName);
    form.set("phone", SMOKE_PHONE);
    form.set("decision", "allow");
    const answer = await client.request("/api/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const back = answer.headers.get("location") ?? "";
    expect(answer.status === 303 && back.startsWith(SMOKE_REDIRECT), `sign in: HTTP ${answer.status} → ${back || "(no Location)"}`);
    const returned = new URL(back).searchParams;
    expect(returned.get("state") === state && returned.get("iss") === baseUrl && returned.get("code"), `redirect: ${snippet(back)}`);

    const token = await client.request("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: returned.get("code"),
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: SMOKE_REDIRECT,
      }).toString(),
    });
    const t = token.json;
    expect(token.status === 200 && t?.access_token && t?.refresh_token && t?.expires_in === 3600, `token: ${http(token)}`);
    Object.assign(session, { clientId, access: t.access_token, refresh: t.refresh_token });
    return `client ${clientId.slice(0, 16)}…, signed in as ${customerName} (${SMOKE_PHONE}), access token for ${t.expires_in} s`;
  });

  await check("S6", "Signed in: book without a name books as the customer; list_my_bookings; cancel", async () => {
    if (texting) return { skipped: `texting is ${status.texting}: a signed-in booking would text the customer's number` };
    if (!session.access) return { skipped: "S5 didn't sign in" };
    const from = now() + 3 * 60 * 60 * 1000;
    const avail = await callTool("get_availability", {
      service_id: "beard-trim",
      from: new Date(from).toISOString().replace(/\.\d{3}Z$/, "Z"),
      to: new Date(from + 6 * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
      limit: 50,
    });
    const slots = avail.result?.structuredContent?.slots ?? [];
    expect(slots.length > 0, `no open Beard trim starts in the next 6 days: ${http(avail)}`);
    const slot = slots[Math.floor(random() * slots.length)];

    let booking;
    try {
      booking = (await signedIn("book", { service_id: "beard-trim", start: slot.start }, session.access)).booking;
      const who = `${booking.customer.displayName} (${booking.customer.phone ?? "no phone"})`;
      expect(booking.customer.displayName === customerName && booking.customer.phone === SMOKE_PHONE, `booked for ${who}`);
      const mine = await signedIn("list_my_bookings", {}, session.access);
      expect(mine.customer?.name === customerName, `list_my_bookings: signed in as ${snippet(JSON.stringify(mine.customer))}`);
      expect(mine.bookings?.some((b) => b.id === booking.id), `list_my_bookings doesn't list ${booking.id}`);
      const cancelled = await signedIn("cancel", { booking_id: booking.id }, session.access);
      expect(cancelled.booking?.status === "cancelled", `cancel: ${cancelled.booking?.status}`);
      booking = undefined;
      return `${slot.display}: booked for ${who}, listed among ${mine.bookings.length}, cancelled`;
    } finally {
      // Never leave the hold behind, even after a failed check.
      if (booking) await callTool("cancel", { booking_id: booking.id }).catch(() => {});
    }
  });

  await check("S7", "Refresh: a new access token that works", async () => {
    if (!session.refresh) return { skipped: "S5 didn't sign in" };
    const res = await client.request("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refresh, client_id: session.clientId }).toString(),
    });
    expect(res.status === 200 && res.json?.access_token && res.json.access_token !== session.access, `refresh: ${http(res)}`);
    const mine = await signedIn("list_my_bookings", {}, res.json.access_token);
    expect(mine.customer?.name === customerName, `list_my_bookings with the new token: ${snippet(JSON.stringify(mine.customer))}`);
    return `new access token works: list_my_bookings as ${mine.customer.name}`;
  });
}
