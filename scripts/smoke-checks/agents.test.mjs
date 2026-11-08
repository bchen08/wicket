import { describe, expect, it } from "vitest";
import { BYPASS_HEADER, loadSmokeChecks, PREVIEW_OWNER_TOKEN, runSmoke, SMOKE_AGENT } from "../smoke.mjs";
import agents, { SMOKE_PAP_AGENT } from "./agents.mjs";

// The agent identity smoke checks (A1–A6) against a stubbed deployment, and that pnpm smoke loads them from
// scripts/smoke-checks/. Only the A rows are checked here; the core checks have their own tests (smoke.test.mjs).
// Signatures aren't checked by the stub: lib/server/pap and lib/server/identity test the real verification.

const BASE = "https://emergent-git-claude-39-agent-identity.vercel.app";
const STARTS = Array.from({ length: 12 }, (_, i) => `2026-11-10T${String(9 + i).padStart(2, "0")}:00:00-05:00`);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const readyStatus = (overrides = {}) => ({
  status: "ready",
  environment: "preview",
  commit: "abcdef0",
  database: { mode: "postgres", reachable: true, shopName: "Hart's Barbers (preview)", writesAllowed: true, schema: "current", missing: [] },
  ownerAccess: "configured",
  approvalLinks: { origin: BASE },
  alerts: "log",
  deposits: "off",
  problems: [],
  ...overrides,
});

/** The agent a Poppy-Session JWT names: { clientId, name } from its iss (a data: URL of client metadata), or null. */
function papAgent(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const metadata = JSON.parse(Buffer.from(payload.iss.split(",")[1], "base64").toString("utf8"));
    return typeof metadata.client_name === "string" ? { clientId: payload.iss, name: metadata.client_name } : null;
  } catch {
    return null;
  }
}

/**
 * A deployment that answers discovery, the owner's bookings and agents lists, MCP availability and book, and
 * decline; 404 otherwise. (The core booking loop books here too, so the agent checks' bookings are the last two.)
 * `ignoreSession`: a server that drops the Poppy-Session header, so nothing is ever confirmed.
 */
function fakeDeployment({ status = readyStatus(), ignoreSession = false } = {}) {
  const state = { requests: [], bookings: [], agents: new Map() };
  const held = (start) => state.bookings.some((b) => b.start === start && b.status === "awaiting_approval");
  const view = (b) => ({
    id: b.id,
    serviceId: b.service,
    status: b.status,
    start: b.start,
    display: `Tue 10 Nov, ${b.start.slice(11, 16)}`,
    agent: { name: b.agent, confirmed: b.clientId !== null, ...(b.clientId ? { clientId: b.clientId } : {}) },
    approval: { url: `${BASE}/approve/${b.token}`, expiresAt: "x" },
  });
  const isOwner = (headers) => headers.get("authorization") === `Bearer ${PREVIEW_OWNER_TOKEN}`;

  async function fetch(href, init = {}) {
    const url = new URL(href);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    state.requests.push({ path: url.pathname, method, headers });
    if (method === "GET" && url.pathname === "/api/status") return json(status);
    if (method === "GET" && url.pathname === "/.well-known/poppy.json") {
      return json({
        protocol_version: "0.4",
        organization: { name: "Hart's Barbers (preview)", domain: url.host },
        apis: [{ type: "mcp", url: `${BASE}/api/mcp`, description: "Book." }],
      });
    }
    if (method === "GET" && url.pathname === "/.well-known/front-desk.json") return json({ poppy: `${BASE}/.well-known/poppy.json` });
    if (method === "GET" && url.pathname === "/api/shops/harts/bookings" && isOwner(headers)) return json({ bookings: state.bookings.map(view) });
    if (method === "GET" && url.pathname === "/api/shops/harts/agents" && isOwner(headers)) {
      return json({
        agents: [...state.agents].map(([clientId, name]) => ({
          clientId,
          name,
          lastSeen: "2026-11-08T07:00:00-05:00",
          bookings: state.bookings.filter((b) => b.clientId === clientId).length,
        })),
        unconfirmedBookings: state.bookings.filter((b) => b.clientId === null).length,
      });
    }
    const decline = /^\/api\/approvals\/([^/]+)\/decline$/.exec(url.pathname);
    if (method === "POST" && decline) {
      const b = state.bookings.find((x) => x.token === decline[1]);
      if (!b) return json({ error: { code: "booking_not_found" } }, 404);
      b.status = "cancelled";
      return json({ booking: view(b) });
    }
    if (method === "POST" && url.pathname === "/api/mcp") {
      const msg = JSON.parse(init.body);
      const reply = (structuredContent) => json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }], structuredContent } });
      let pap = null;
      if (headers.has("poppy-session") && !ignoreSession) {
        pap = papAgent(headers.get("poppy-session"));
        if (!pap) return json({ error: "invalid_session", error_description: "Poppy-Session must be a compact JWT." }, 400);
        state.agents.set(pap.clientId, pap.name);
      }
      const { name, arguments: args, _meta } = msg.params ?? {};
      if (msg.method === "tools/call" && name === "get_availability") {
        return reply({ slots: STARTS.filter((start) => !held(start)).map((start) => ({ start })) });
      }
      if (msg.method === "tools/call" && name === "book") {
        const n = state.bookings.length + 1;
        const b = {
          id: `booking-${n}`,
          token: `token-${n}`,
          start: args.start,
          service: args.service_id,
          status: "awaiting_approval",
          agent: pap?.name ?? _meta?.["io.modelcontextprotocol/clientInfo"]?.name ?? "unknown agent",
          clientId: pap?.clientId ?? null,
        };
        state.bookings.push(b);
        return reply({ booking: view(b) });
      }
      return json({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
    return new Response("not found", { status: 404 });
  }
  return { fetch, state };
}

/** Run pnpm smoke with only the agent checks as feature checks: its rows, and the whole run. */
async function aRows(deployment, options = {}) {
  const run = await runSmoke({
    baseUrl: BASE,
    fetch: deployment.fetch,
    now: () => Date.parse("2026-11-08T12:00:00Z"),
    random: () => 0,
    print: () => {},
    checks: [agents],
    ...options,
  });
  return run.rows.filter((r) => r.item.startsWith("A") || r.title.startsWith("Cleanup: the agent checks"));
}

const summary = (rows) => rows.map((r) => [r.item, r.result]);

describe("agent identity smoke checks", () => {
  it("pnpm smoke loads them from scripts/smoke-checks/", async () => {
    expect(await loadSmokeChecks()).toContain(agents);
  });

  it("writes allowed: A1–A6 pass, and both bookings are declined", async () => {
    const deployment = fakeDeployment();
    const rows = await aRows(deployment);
    expect(rows.map((r) => [r.item, r.result, r.evidence])).toEqual([
      ["A1", "PASS", `PAP 0.4, "Hart's Barbers (preview)" on ${new URL(BASE).host}, mcp ${BASE}/api/mcp; listed in front-desk.json`],
      ["A2", "PASS", '400, error invalid_session ("Poppy-Session must be a compact JWT.")'],
      ["A3", "PASS", expect.stringContaining(`awaiting_approval, agent "${SMOKE_PAP_AGENT}" confirmed`)],
      ["A4", "PASS", `agent "${SMOKE_PAP_AGENT}", confirmed true`],
      ["A5", "PASS", expect.stringMatching(new RegExp(`"${SMOKE_PAP_AGENT.replace(/[()]/g, "\\$&")}": 1 booking, last seen .*; 1 agents, \\d+ unconfirmed bookings`))],
      ["A6", "PASS", `agent "${SMOKE_AGENT}", confirmed false`],
      ["—", "PASS", "2 made, 2 declined"],
    ]);
    const [pap, plain] = deployment.state.bookings.slice(-2);
    expect(pap).toMatchObject({ service: "beard-trim", agent: SMOKE_PAP_AGENT, status: "cancelled" });
    expect(pap.clientId).toMatch(/^data:application\/json;base64,/);
    expect(plain).toMatchObject({ service: "beard-trim", agent: SMOKE_AGENT, clientId: null, status: "cancelled" });
  });

  it("sends the bypass secret on the demo agent's own requests too", async () => {
    const deployment = fakeDeployment();
    await aRows(deployment, { bypass: "bypass-secret" });
    const demo = deployment.state.requests.filter((r) => r.path === "/.well-known/poppy.json" || r.headers.has("poppy-session"));
    expect(demo.length).toBeGreaterThan(3);
    expect(demo.every((r) => r.headers.get(BYPASS_HEADER) === "bypass-secret")).toBe(true);
  });

  it("production: A3–A6 are SKIPPED (never written to); the read-only checks still run", async () => {
    const status = readyStatus({ environment: "production", database: { ...readyStatus().database, shopName: "Hart's Barbers", writesAllowed: false } });
    const deployment = fakeDeployment({ status });
    const rows = await aRows(deployment);
    expect(summary(rows)).toEqual([
      ["A1", "PASS"],
      ["A2", "PASS"],
      ["A3", "SKIPPED"],
      ["A4", "SKIPPED"],
      ["A5", "SKIPPED"],
      ["A6", "SKIPPED"],
    ]);
    expect(deployment.state.bookings).toEqual([]);
  });

  it("without an owner token, A4 and A5 are SKIPPED and the bookings are still declined", async () => {
    const deployment = fakeDeployment({ status: readyStatus({ environment: "development", database: { ...readyStatus().database, mode: "memory" } }) });
    const rows = await aRows(deployment);
    expect(summary(rows)).toEqual([
      ["A1", "PASS"],
      ["A2", "PASS"],
      ["A3", "PASS"],
      ["A4", "SKIPPED"],
      ["A5", "SKIPPED"],
      ["A6", "PASS"],
      ["—", "PASS"],
    ]);
    expect(deployment.state.bookings.slice(-2).map((b) => b.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("FAIL when a PAP agent's booking isn't confirmed, and its bookings are still declined", async () => {
    const deployment = fakeDeployment({ ignoreSession: true });
    const rows = await aRows(deployment);
    expect(summary(rows)).toEqual([
      ["A1", "PASS"],
      ["A2", "FAIL"],
      ["A3", "FAIL"],
      ["A4", "FAIL"],
      ["A5", "FAIL"],
      ["A6", "PASS"],
      ["—", "PASS"],
    ]);
    expect(rows.find((r) => r.item === "A3").evidence).toContain(`agent "${SMOKE_PAP_AGENT}" unconfirmed`);
    expect(rows.find((r) => r.item === "A4").evidence).toBe("not run: the PAP booking check failed");
    expect(deployment.state.bookings.slice(-2).map((b) => b.status)).toEqual(["cancelled", "cancelled"]);
  });
});
