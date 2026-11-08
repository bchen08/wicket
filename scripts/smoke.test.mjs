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
  alerts: "log",
  deposits: "off",
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
 * behavior. `doubleBook: true` lets the same start be booked twice (a broken server). `ownerToken` is the
 * token its owner routes accept. Approving, declining and cancelling record owner alerts, like the real one.
 * Approving a service with a deposit (anything but a beard-trim) waits for it, with a Stripe URL, when
 * status.deposits is "stripe_test", and confirms it (deposit not_collected) otherwise.
 */
function fakeDeployment({ status = readyStatus(), route, doubleBook = false, ownerToken = PREVIEW_OWNER_TOKEN } = {}) {
  const state = { requests: [], bookings: [], mcp: [], alerts: [] };
  const alert = (b, kind) => state.alerts.unshift({ id: String(state.alerts.length + 1), bookingId: b.id, kind, channel: "log", status: "logged", error: null });
  const isOwner = (headers) => headers.get("authorization") === `Bearer ${ownerToken}`;
  const ACTIVE = ["awaiting_approval", "awaiting_deposit", "confirmed"];
  const held = (start) => state.bookings.some((b) => b.start === start && ACTIVE.includes(b.status));
  const newBooking = (start, service, agent) => {
    const n = state.bookings.length + 1;
    const b = { id: `booking-${n}`, token: `token-${n}`, start, service, status: "awaiting_approval", deposit: "none", agent };
    state.bookings.push(b);
    return b;
  };
  const view = (b) => ({
    id: b.id,
    status: b.status,
    start: b.start,
    display: `Tue 10 Nov, ${b.start.slice(11, 16)}`,
    agent: { name: b.agent },
    deposit: {
      amountCents: b.service === "beard-trim" ? 0 : 1000,
      state: b.deposit,
      ...(b.status === "awaiting_deposit" ? { payUrl: `https://checkout.stripe.com/c/pay/cs_test_${b.id}`, payBy: "x" } : {}),
    },
    ...(b.status === "awaiting_approval" || b.status === "awaiting_deposit"
      ? { approval: { url: `${BASE}/approve/${b.token}`, expiresAt: "x" } }
      : {}),
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
      return isOwner(headers) ? json({ bookings: [] }) : apiError(401, "unauthorized", UNLOCK_NEXT_ACTION);
    }
    if (method === "GET" && url.pathname === "/api/shops/harts/alerts") {
      return isOwner(headers) ? json({ alerts: state.alerts.slice(0, 50) }) : apiError(401, "unauthorized", UNLOCK_NEXT_ACTION);
    }
    if (url.pathname === "/api/shops/nope/services") return apiError(404, "not_found");
    if (method === "GET" && url.pathname === "/api/mcp") return new Response(null, { status: 405 });

    // The web booking API.
    if (method === "GET" && url.pathname === "/api/shops/harts/availability") {
      const free = STARTS.filter((start) => !held(start)).map((start) => ({ start, display: `Tue 10 Nov, ${start.slice(11, 16)}` }));
      const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${10 + i}`, display: "x", slots: i === 0 ? free : [] }));
      return json({ from: "2026-11-10", to: "2026-11-17", days });
    }
    if (method === "GET" && url.pathname === "/api/shops/harts/agents.md") {
      const text = `MCP: ${BASE}/api/mcp\nGET ${BASE}/api/shops/harts/availability\nPOST ${BASE}/api/shops/harts/book\nSend booking.approval.url.`;
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (method === "GET" && url.pathname === "/.well-known/front-desk.json") {
      return json({ mcp: `${BASE}/api/mcp`, webApi: `${BASE}/api/shops/harts`, agentsMd: `${BASE}/api/shops/harts/agents.md` });
    }
    if (method === "POST" && url.pathname === "/api/shops/harts/book") {
      const form = (headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
      const fields = form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
      if (held(fields.start) && !doubleBook) {
        if (!form) return apiError(409, "slot_taken");
        const back = new URL(headers.get("referer"));
        back.searchParams.set("error", "slot_taken");
        back.searchParams.set("message", "That time is already booked.");
        return new Response(null, { status: 303, headers: { location: back.href } });
      }
      const b = newBooking(fields.start, fields.service, fields.bookedBy ?? "web");
      if (form) return new Response(null, { status: 303, headers: { location: `${BASE}/approve/${b.token}` } });
      return json({ booking: view(b), statusUrl: `${BASE}/api/approvals/${b.token}`, next_action: "Send the link." }, 201);
    }

    const decline = /^\/api\/approvals\/([^/]+)\/decline$/.exec(url.pathname);
    if (method === "POST" && decline) {
      const b = state.bookings.find((x) => x.token === decline[1]);
      if (!b || b.status !== "awaiting_approval") return apiError(409, "approval_closed");
      b.status = "cancelled";
      alert(b, "booking_cancelled");
      return json({ booking: view(b) });
    }
    const approve = /^\/api\/approvals\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === "POST" && approve) {
      const b = state.bookings.find((x) => x.token === approve[1]);
      if (!b || b.status !== "awaiting_approval") return apiError(409, "approval_closed");
      if (b.service === "beard-trim") {
        b.status = "confirmed";
      } else if (status.deposits === "stripe_test") {
        b.status = "awaiting_deposit";
        b.deposit = "awaiting_payment";
      } else {
        b.status = "confirmed";
        b.deposit = "not_collected";
      }
      if (b.status === "confirmed") alert(b, "booking_confirmed");
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
        const b = newBooking(args.start, args.service_id, _meta?.["io.modelcontextprotocol/clientInfo"]?.name ?? "unknown agent");
        return reply(toolResult({ booking: view(b) }));
      }
      if (name === "get_booking") {
        const b = state.bookings.find((x) => x.id === args.booking_id);
        return reply(b ? toolResult({ booking: view(b) }) : toolError("booking_not_found"));
      }
      if (name === "cancel") {
        const b = state.bookings.find((x) => x.id === args.booking_id);
        if (!b || !ACTIVE.includes(b.status)) return reply(toolError("not_cancellable"));
        if (b.status === "awaiting_deposit") b.deposit = "released";
        b.status = "cancelled";
        alert(b, "booking_cancelled");
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
    expect(results(run.rows)).toEqual(Array(31).fill("PASS"));
    expect(run.line).toBe("PASS: 31 passed.");
    expect(run.output).toMatch(/\nPASS: 31 passed\.$/);
    // Over MCP: one booking declined, a Beard trim approved and then cancelled by the cleanup, and the deposit
    // check's Haircut approved and cancelled. Over the web: the JSON booking declined, and the form post's
    // booking declined by the cleanup. All by front-desk-smoke.
    expect(deployment.state.bookings.map((b) => [b.status, b.agent])).toEqual(Array(5).fill(["cancelled", SMOKE_AGENT]));
    expect(deployment.state.bookings.map((b) => b.service)).toEqual(["haircut", "beard-trim", "haircut", "haircut", "haircut"]);
    // Deposits off: the approved Haircut was confirmed without collecting its deposit.
    expect(run.rows.find((r) => r.title.startsWith("Approve a Haircut"))).toMatchObject({
      item: "19",
      title: "Approve a Haircut (deposits off) → confirmed, deposit not_collected",
      evidence: "Tue 10 Nov, 10:30: confirmed, deposit not_collected",
    });
    expect(run.rows.find((r) => r.title.includes("booking_cancelled"))).toMatchObject({ item: "14", evidence: "booking_cancelled by log, logged" });
    expect(run.rows.find((r) => r.title.includes("booking_confirmed"))).toMatchObject({ item: "17", evidence: "booking_confirmed by log, logged" });
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
    expect(run.rows.filter((r) => r.result === "PASS")).toHaveLength(30);
    expect(run.line).toBe("FAIL: 1 failed, 30 passed, 0 skipped.");
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
    expect(run.rows.filter((r) => r.result === "SKIPPED").map((r) => r.item)).toEqual([
      "5", "5", "11", "11", "12", "14", "14", "14", "17", "17", "19", "19", "19", "19", "W4", "W4", "W4", "W5",
    ]);
    // The read-only web checks still run; no cleanup row: it made no bookings.
    expect(run.rows.filter((r) => r.item.startsWith("W") && r.result === "PASS").map((r) => r.item)).toEqual(["W1", "W2", "W3"]);
    expect(run.line).toBe("PASS: 12 passed, 18 skipped (a skipped check is not a pass: verify those by hand).");
    expect(deployment.state.mcp.some((c) => c.params?.name === "book")).toBe(false);
    expect(deployment.state.requests.some((r) => r.path === "/api/shops/harts/book")).toBe(false);
    expect(deployment.state.requests.some((r) => r.headers.get("authorization"))).toBe(false);
  });

  it("--owner-token overrides the preview token, and is never printed", async () => {
    const deployment = fakeDeployment({ ownerToken: "prod-secret-token" });
    const run = await smoke(deployment, { ownerToken: "prod-secret-token" });
    const sent = deployment.state.requests.map((r) => r.headers.get("authorization")).filter(Boolean);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set(["Bearer prod-secret-token"]));
    expect(run.exitCode).toBe(EXIT.pass);
    expect(run.output).not.toContain("prod-secret-token");
  });

  it("FAIL: an alert that's missing, or recorded as failed", async () => {
    // A server that records no booking_cancelled alert, and a failed booking_confirmed one.
    const deployment = fakeDeployment({
      route: (url, init, state) => {
        if (url.pathname !== "/api/shops/harts/alerts" || !new Headers(init.headers).get("authorization")) return undefined;
        const confirmed = state.alerts.filter((a) => a.kind === "booking_confirmed").map((a) => ({ ...a, channel: "email", status: "failed", error: "Resend answered HTTP 403: nope" }));
        return json({ alerts: confirmed });
      },
    });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.fail);
    expect(run.rows.find((r) => r.title.includes("booking_cancelled"))).toMatchObject({
      result: "FAIL",
      evidence: "no booking_cancelled alert for booking-1 among the newest 0",
    });
    expect(run.rows.find((r) => r.title.includes("booking_confirmed"))).toMatchObject({
      result: "FAIL",
      evidence: "booking_confirmed by email, failed: Resend answered HTTP 403: nope",
    });
  });

  it("without an owner token (not a preview), the alert checks are SKIPPED, but the approval still runs", async () => {
    const deployment = fakeDeployment({ status: readyStatus({ environment: "development", database: { ...readyStatus().database, mode: "memory" } }) });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.pass);
    expect(run.rows.filter((r) => r.result === "SKIPPED").map((r) => r.title)).toEqual([
      `Owner bookings with Bearer ${PREVIEW_OWNER_TOKEN} → 200`,
      `Owner alerts with Bearer ${PREVIEW_OWNER_TOKEN} → 200`,
      "The owner's alerts list has booking_cancelled for it",
      "The owner's alerts list has booking_confirmed for it",
    ]);
    expect(run.rows.find((r) => r.item === "17" && r.title.startsWith("Book a Beard trim"))).toMatchObject({ result: "PASS" });
  });

  it("declines every booking it made even when a booking check fails", async () => {
    // A broken server that books the same start twice: the slot_taken check fails, and both bookings
    // must still be declined.
    const deployment = fakeDeployment({ doubleBook: true });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.fail);
    expect(run.rows.find((r) => r.title.includes("slot_taken"))).toMatchObject({ result: "FAIL", evidence: "booked again: booking-2" });
    // The web form post at the held start books it again too, and fails.
    expect(run.rows.find((r) => r.title.includes("?error=slot_taken"))).toMatchObject({ result: "FAIL" });
    expect(run.rows.at(-1)).toMatchObject({ result: "PASS", evidence: "6 made, 6 declined or cancelled: none left behind" });
    expect(deployment.state.bookings.map((b) => b.status)).toEqual(Array(6).fill("cancelled"));
  });

  it("web booking: a form post that doesn't redirect to /approve/ fails W5, and the JSON booking is still declined", async () => {
    const deployment = fakeDeployment({
      route: (url, init) => {
        const form = new Headers(init.headers).get("content-type")?.startsWith("application/x-www-form-urlencoded");
        if (url.pathname === "/api/shops/harts/book" && form) return new Response("<html>Booked!</html>", { status: 200 });
        return undefined;
      },
    });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.fail);
    const web = run.rows.filter((r) => r.item.startsWith("W")).map((r) => [r.item, r.result]);
    expect(web).toEqual([
      ["W1", "PASS"],
      ["W2", "PASS"],
      ["W3", "PASS"],
      ["W4", "PASS"],
      ["W4", "FAIL"],
      ["W4", "PASS"],
      ["W5", "FAIL"],
    ]);
    expect(run.rows.find((r) => r.item === "W5").evidence).toBe("HTTP 200 <html>Booked!</html>");
    // The MCP loop's approved booking is cancelled; the deposit check cancelled its own; the web JSON
    // booking was declined by W4.
    expect(run.rows.at(-1)).toMatchObject({ result: "PASS", evidence: "4 made, 4 declined or cancelled: none left behind" });
  });

  it("deposits stripe_test: approving a Haircut waits for its deposit with a Stripe URL; cancelling releases it and frees the start", async () => {
    const deployment = fakeDeployment({ status: readyStatus({ deposits: "stripe_test" }) });
    const run = await smoke(deployment);
    expect(run.verdict).toBe("PASS");
    const deposits = run.rows.filter((r) => r.item === "19");
    expect(deposits.map((r) => [r.title, r.result])).toEqual([
      ["Approve a Haircut (deposits stripe_test) → awaiting_deposit, Stripe Checkout URL", "PASS"],
      ["get_booking: awaiting_deposit, the same approval link", "PASS"],
      ["cancel it → cancelled, deposit released", "PASS"],
      ["The cancelled start is free again", "PASS"],
    ]);
    expect(deposits[0].evidence).toBe("Tue 10 Nov, 10:30: awaiting_deposit, deposit awaiting_payment, pay at https://checkout.stripe.com/c/pay/cs_test_…");
    // The Beard trim (no deposit) still confirms at once, so item 17's alert check passes.
    expect(run.rows.find((r) => r.title.includes("booking_confirmed"))).toMatchObject({ result: "PASS" });
    // It never pays: the deposit check's Haircut ends cancelled with the deposit released.
    expect(deployment.state.bookings[2]).toMatchObject({ service: "haircut", status: "cancelled", deposit: "released" });
  });

  it("deposits stripe_test: FAIL when approving confirms at once instead of waiting for the deposit", async () => {
    const deployment = fakeDeployment({
      status: readyStatus({ deposits: "stripe_test" }),
      route: (url, _init, state) => {
        const m = /^\/api\/approvals\/([^/]+)\/approve$/.exec(url.pathname);
        if (!m) return undefined;
        const b = state.bookings.find((x) => x.token === m[1]);
        b.status = "confirmed";
        b.deposit = b.service === "beard-trim" ? "none" : "not_collected";
        return json({ booking: { id: b.id, status: "confirmed", display: `Tue 10 Nov, ${b.start.slice(11, 16)}`, deposit: { amountCents: 1000, state: b.deposit } } });
      },
    });
    const run = await smoke(deployment);
    expect(run.exitCode).toBe(EXIT.fail);
    expect(run.rows.find((r) => r.item === "19")).toMatchObject({ result: "FAIL", evidence: "Tue 10 Nov, 10:30: confirmed, deposit not_collected" });
    // Still cleaned up.
    expect(run.rows.at(-1)).toMatchObject({ result: "PASS" });
    expect(deployment.state.bookings.every((b) => b.status === "cancelled")).toBe(true);
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
    expect(run.rows.at(-1)).toMatchObject({
      result: "FAIL",
      evidence: "still held: booking-1 (internal), booking-2 (internal), booking-3 (internal)",
    });
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
