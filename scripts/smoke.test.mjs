import { describe, expect, it } from "vitest";
import {
  blockedReasons,
  BYPASS_HEADER,
  EXIT,
  parseArgs,
  PREVIEW_OWNER_TOKEN,
  runSmoke,
  SMOKE_AGENT,
  UNLOCK_NEXT_ACTION,
} from "./smoke.mjs";

// The smoke script's verdicts and exit codes, against a stubbed fetch that plays a Front Desk deployment.

const BASE = "https://emergent-git-claude-24-verifiable.vercel.app";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const STARTS = ["2026-11-10T10:00:00-05:00", "2026-11-10T10:30:00-05:00", "2026-11-10T11:00:00-05:00"];

const readyStatus = (overrides = {}) => ({
  status: "ready",
  environment: "preview",
  commit: SHA.slice(0, 7),
  database: {
    mode: "postgres",
    reachable: true,
    shopName: "Hart's Barbers (preview)",
    writesAllowed: true,
    schema: "current",
    missing: [],
  },
  ownerAccess: "configured",
  approvalLinks: { origin: BASE },
  problems: [],
  ...overrides,
});

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const apiError = (status, code, nextAction = "Fix it.") => json({ error: { code, message: code, next_action: nextAction } }, status);
const toolResult = (structuredContent) => ({ content: [{ type: "text", text: "ok" }], structuredContent });
const toolError = (code) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message: code, next_action: "x" } }) }] });

/**
 * A fake deployment. `route(url, init, state)` may answer a request first (return a Response) to change one
 * behavior. `doubleBook: true` lets the same start be booked twice (a broken server).
 */
function fakeDeployment({ status = readyStatus(), route, doubleBook = false } = {}) {
  const state = { requests: [], bookings: [], mcp: [] };
  const held = (start) => state.bookings.some((b) => b.start === start && b.status === "awaiting_approval");
  const view = (b) => ({
    id: b.id,
    status: b.status,
    start: b.start,
    display: `Tue 10 Nov, ${b.start.slice(11, 16)}`,
    agent: { name: b.agent },
    ...(b.status === "awaiting_approval" ? { approval: { url: `${BASE}/approve/${b.token}`, expiresAt: "x" } } : {}),
  });

  async function fetch(href, init = {}) {
    const url = new URL(href);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    state.requests.push({ path: url.pathname, method, headers });
    const override = route && (await route(url, init, state));
    if (override) return override;

    if (method === "GET" && url.pathname === "/api/status") return json(status);
    if (method === "GET" && url.pathname === "/api/health") return json({ status: "ok", service: "emergent" });
    if (method === "GET" && url.pathname === "/api/shops/harts/services") {
      return json({
        shop: { slug: "harts", name: "Hart's Barbers (preview)", timezone: "America/New_York" },
        services: [{ id: "haircut" }, { id: "beard-trim" }, { id: "haircut-beard" }],
      });
    }
    if (method === "GET" && url.pathname === "/api/shops/harts/bookings") {
      return headers.get("authorization") === `Bearer ${PREVIEW_OWNER_TOKEN}`
        ? json({ bookings: [] })
        : apiError(401, "unauthorized", UNLOCK_NEXT_ACTION);
    }
    if (url.pathname === "/api/shops/nope/services") return apiError(404, "not_found");
    if (method === "GET" && url.pathname === "/api/mcp") return new Response(null, { status: 405 });

    const decline = /^\/api\/approvals\/([^/]+)\/decline$/.exec(url.pathname);
    if (method === "POST" && decline) {
      const b = state.bookings.find((x) => x.token === decline[1]);
      if (!b || b.status !== "awaiting_approval") return apiError(409, "not_pending");
      b.status = "cancelled";
      return json({ booking: view(b) });
    }

    if (method === "POST" && url.pathname === "/api/mcp") {
      const msg = JSON.parse(init.body);
      state.mcp.push({ method: msg.method, params: msg.params, headers });
      const reply = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") {
        // Like the real server: legacy requests are answered as one SSE event.
        const data = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "front-desk", version: "0.5.0" } } });
        return new Response(`event: message\ndata: ${data}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (msg.method === "tools/list") {
        return reply({ tools: ["list_services", "get_policies", "get_availability", "book", "get_booking", "cancel"].map((name) => ({ name })) });
      }
      const { name, arguments: args, _meta } = msg.params;
      if (name === "get_availability") {
        const from = Date.parse(args.from);
        const to = Date.parse(args.to);
        const slots = STARTS.filter((s) => Date.parse(s) >= from && Date.parse(s) < to && !held(s)).map((start) => ({ start }));
        return reply(toolResult({ slots }));
      }
      if (name === "book") {
        if (held(args.start) && !doubleBook) return reply(toolError("slot_taken"));
        const n = state.bookings.length + 1;
        const b = { id: `booking-${n}`, token: `token-${n}`, start: args.start, status: "awaiting_approval", agent: _meta?.["io.modelcontextprotocol/clientInfo"]?.name ?? "unknown agent" };
        state.bookings.push(b);
        return reply(toolResult({ booking: view(b) }));
      }
      if (name === "get_booking") {
        const b = state.bookings.find((x) => x.id === args.booking_id);
        return reply(b ? toolResult({ booking: view(b) }) : toolError("booking_not_found"));
      }
      if (name === "cancel") {
        const b = state.bookings.find((x) => x.id === args.booking_id);
        if (!b || b.status !== "awaiting_approval") return reply(toolError("not_cancellable"));
        b.status = "cancelled";
        return reply(toolResult({ booking: view(b) }));
      }
    }
    return new Response("not found", { status: 404 });
  }

  return { fetch, state };
}

/** Run the script against a fake deployment, collecting what it prints. */
async function smoke(deployment, options = {}) {
  const lines = [];
  const outcome = await runSmoke({
    baseUrl: BASE,
    fetch: deployment.fetch,
    now: () => Date.parse("2026-11-08T12:00:00Z"),
    random: () => 0,
    print: (line) => lines.push(line),
    ...options,
  });
  return { ...outcome, output: lines.join("\n") };
}

const results = (rows) => rows.map((r) => r.result);

describe("pnpm smoke", () => {
  it("PASS: every check passes on a ready preview, exits 0 and leaves no booking behind", async () => {
    const deployment = fakeDeployment();
    const run = await smoke(deployment, { commit: SHA, bypass: "bypass-secret" });

    expect(run.verdict).toBe("PASS");
    expect(run.exitCode).toBe(EXIT.pass);
    expect(results(run.rows)).toEqual(Array(15).fill("PASS"));
    expect(run.line).toBe("PASS: 15 passed.");
    expect(run.output).toMatch(/\nPASS: 15 passed\.$/);
    // Every booking it made is declined.
    expect(deployment.state.bookings.map((b) => b.status)).toEqual(["cancelled"]);
    // The bypass secret went on every request, and the secret itself is never printed.
    expect(deployment.state.requests.every((r) => r.headers.get(BYPASS_HEADER) === "bypass-secret")).toBe(true);
    expect(run.output).not.toContain("bypass-secret");
  });

  it("says who it is: initialize and every tool call carry clientInfo front-desk-smoke, so bookings show it", async () => {
    const deployment = fakeDeployment();
    await smoke(deployment);
    const [init, ...calls] = deployment.state.mcp;
    expect(init.method).toBe("initialize");
    expect(init.params.clientInfo.name).toBe(SMOKE_AGENT);
    const book = calls.find((c) => c.params?.name === "book");
    expect(book.params._meta["io.modelcontextprotocol/clientInfo"].name).toBe(SMOKE_AGENT);
    expect(book.headers.get("mcp-method")).toBe("tools/call");
    expect(book.headers.get("mcp-name")).toBe("book");
    expect(deployment.state.bookings[0].agent).toBe(SMOKE_AGENT);
  });

  it("FAIL: a failing check fails the run and exits 1, and the other checks still run", async () => {
    const deployment = fakeDeployment({
      route: (url) => (url.pathname === "/api/health" ? new Response("boom", { status: 500 }) : undefined),
    });
    const run = await smoke(deployment);
    expect(run.verdict).toBe("FAIL");
    expect(run.exitCode).toBe(EXIT.fail);
    expect(run.rows.find((r) => r.item === "2")).toMatchObject({ result: "FAIL", evidence: "HTTP 500 boom" });
    expect(run.rows.filter((r) => r.result === "PASS")).toHaveLength(14);
    expect(run.line).toBe("FAIL: 1 failed, 14 passed, 0 skipped.");
  });

  it("BLOCKED: not_ready prints the problems, runs nothing else and exits 2", async () => {
    const problems = [
      "The database schema is outdated, missing approvals.token: rebuild the Preview database from this branch.",
      "OWNER_API_TOKEN isn't set: set it for Preview in Vercel.",
    ];
    const deployment = fakeDeployment({ status: readyStatus({ status: "not_ready", problems }) });
    const run = await smoke(deployment);
    expect(run.verdict).toBe("BLOCKED");
    expect(run.exitCode).toBe(EXIT.blocked);
    expect(run.line).toBe(`BLOCKED: ${problems.join(" ")}`);
    expect(run.output.split("\n").at(-1)).toBe(run.line);
    expect(run.rows).toEqual([]);
    expect(deployment.state.requests.map((r) => r.path)).toEqual(["/api/status"]);
  });

  it("BLOCKED: a deployment at another commit than --commit", async () => {
    const deployment = fakeDeployment({ status: readyStatus({ commit: "1111111" }) });
    const run = await smoke(deployment, { commit: SHA });
    expect(run.exitCode).toBe(EXIT.blocked);
    expect(run.line).toMatch(/^BLOCKED: The deployment is at commit 1111111, not abcdef0: wait for Vercel/);
    expect(deployment.state.requests).toHaveLength(1);
  });

  it("BLOCKED: Vercel's login redirect without --bypass says to pass the bypass secret", async () => {
    const login = () =>
      new Response(null, { status: 302, headers: { location: "https://vercel.com/sso-api?url=https%3A%2F%2Femergent.vercel.app" } });
    const run = await smoke(fakeDeployment({ route: login }));
    expect(run.exitCode).toBe(EXIT.blocked);
    expect(run.line).toBe("BLOCKED: preview needs the Vercel bypass secret (--bypass)");

    const refused = await smoke(fakeDeployment({ route: login }), { bypass: "wrong" });
    expect(refused.line).toMatch(/^BLOCKED: Vercel refused the bypass secret/);
  });

  it("BLOCKED: Vercel's 401 login page counts as the login wall too", async () => {
    const page = () =>
      new Response("<html><title>Authentication Required</title>Vercel</html>", { status: 401, headers: { "content-type": "text/html" } });
    const run = await smoke(fakeDeployment({ route: page }));
    expect(run.line).toBe("BLOCKED: preview needs the Vercel bypass secret (--bypass)");
  });

  it("BLOCKED: a deployment without /api/status, or one that can't be reached", async () => {
    const old = await smoke(fakeDeployment({ route: (url) => (url.pathname === "/api/status" ? new Response("nope", { status: 404 }) : undefined) }));
    expect(old.exitCode).toBe(EXIT.blocked);
    expect(old.line).toMatch(/answered HTTP 404 nope: this deployment is older than \/api\/status/);

    const down = await smoke({ fetch: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })) });
    expect(down.line).toBe(`BLOCKED: Can't reach ${BASE}/api/status: fetch failed (ENOTFOUND).`);
  });

  it("production: skips the booking loop (writes nothing) and the owner 200 check without --owner-token; still exits 0", async () => {
    const status = readyStatus({
      environment: "production",
      database: { ...readyStatus().database, shopName: "Hart's Barbers", writesAllowed: false },
    });
    const deployment = fakeDeployment({ status });
    const run = await smoke(deployment);
    expect(run.verdict).toBe("PASS");
    expect(run.exitCode).toBe(EXIT.pass);
    expect(run.rows.filter((r) => r.result === "SKIPPED").map((r) => r.item)).toEqual(["5", "11", "11", "12", "14", "14"]);
    // No cleanup row either: it made no bookings.
    expect(run.line).toBe("PASS: 8 passed, 6 skipped (a skipped check is not a pass: verify those by hand).");
    expect(deployment.state.mcp.some((c) => c.params?.name === "book")).toBe(false);
    expect(deployment.state.requests.some((r) => r.headers.get("authorization"))).toBe(false);
  });

  it("--owner-token overrides the preview token, and is never printed", async () => {
    let sent;
    const deployment = fakeDeployment({
      route: (url, init) => {
        if (url.pathname !== "/api/shops/harts/bookings") return undefined;
        sent = new Headers(init.headers).get("authorization");
        return sent ? json({ bookings: [] }) : apiError(401, "unauthorized", UNLOCK_NEXT_ACTION);
      },
    });
    const run = await smoke(deployment, { ownerToken: "prod-secret-token" });
    expect(sent).toBe("Bearer prod-secret-token");
    expect(run.exitCode).toBe(EXIT.pass);
    expect(run.output).not.toContain("prod-secret-token");
  });

  it("declines every booking it made even when a booking check fails", async () => {
    // A broken server that books the same start twice: the slot_taken check fails, and both bookings
    // must still be declined.
    const deployment = fakeDeployment({ doubleBook: true });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.fail);
    expect(run.rows.find((r) => r.title.includes("slot_taken"))).toMatchObject({ result: "FAIL", evidence: "booked again: booking-2" });
    expect(run.rows.at(-1)).toMatchObject({ result: "PASS", evidence: "2 made, 2 declined: none left behind" });
    expect(deployment.state.bookings.map((b) => b.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("fails the cleanup row when a booking can't be declined or cancelled", async () => {
    const deployment = fakeDeployment({
      route: (url, init) => {
        if (/\/decline$/.test(url.pathname)) return new Response("down", { status: 503 });
        if (url.pathname === "/api/mcp" && JSON.parse(init.body).params?.name === "cancel") {
          return json({ jsonrpc: "2.0", id: 1, result: toolError("internal") });
        }
        return undefined;
      },
    });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.fail);
    expect(run.rows.at(-1)).toMatchObject({ result: "FAIL", evidence: "still held: booking-1 (internal)" });
  });
});

describe("parseArgs", () => {
  it("reads the URL and the options, as --flag value or --flag=value", () => {
    expect(parseArgs([`${BASE}/`, "--commit", SHA.toUpperCase(), "--bypass=s", "--owner-token", "t"])).toEqual({
      baseUrl: BASE,
      commit: SHA,
      bypass: "s",
      ownerToken: "t",
    });
  });

  it("takes the bypass secret from VERCEL_AUTOMATION_BYPASS_SECRET; --bypass wins", () => {
    const env = { VERCEL_AUTOMATION_BYPASS_SECRET: "from-env" };
    expect(parseArgs([BASE], env).bypass).toBe("from-env");
    expect(parseArgs([BASE, "--bypass", "flag"], env).bypass).toBe("flag");
  });

  it("adds https:// to a bare host, and http:// to a local one", () => {
    expect(parseArgs(["emergent.vercel.app"]).baseUrl).toBe("https://emergent.vercel.app");
    expect(parseArgs(["localhost:3000"]).baseUrl).toBe("http://localhost:3000");
  });

  it("refuses missing or unknown arguments", () => {
    expect(parseArgs([]).error).toMatch(/^Usage: pnpm smoke <base-url>/);
    expect(parseArgs([BASE, "--nope"]).error).toMatch(/^Unknown option --nope/);
    expect(parseArgs([BASE, "--commit"]).error).toMatch(/--commit needs a value/);
    expect(parseArgs([BASE, "--commit", "main"]).error).toMatch(/--commit must be a commit sha/);
  });
});

describe("blockedReasons", () => {
  it("matches a full sha against the deployment's 7 characters, and a short one too", () => {
    expect(blockedReasons(readyStatus(), SHA)).toEqual([]);
    expect(blockedReasons(readyStatus(), SHA.slice(0, 7))).toEqual([]);
    expect(blockedReasons(readyStatus({ commit: null }), SHA)[0]).toMatch(/doesn't report its commit/);
  });

  it("lists a stale commit before the problems", () => {
    const status = readyStatus({ status: "not_ready", commit: "1111111", problems: ["Fix A."] });
    expect(blockedReasons(status, SHA)).toEqual([
      "The deployment is at commit 1111111, not abcdef0: wait for Vercel to deploy the PR's head commit, then run this again.",
      "Fix A.",
    ]);
  });
});
