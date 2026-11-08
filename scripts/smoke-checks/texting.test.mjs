import { describe, expect, it } from "vitest";
import { loadSmokeChecks, runSmoke } from "../smoke.mjs";
import texting from "./texting.mjs";

// The texting smoke checks (T1–T4) against a stubbed deployment, and that pnpm smoke loads them from
// scripts/smoke-checks/. Only the T rows are checked here; the core checks have their own tests (smoke.test.mjs).

const BASE = "https://emergent-git-claude-texting.vercel.app";
const START = "2026-11-10T10:00:00-05:00";

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
  texting: "off",
  problems: [],
  ...overrides,
});

/**
 * A deployment that answers /api/status, the owner code and session routes, MCP book and decline; 404 otherwise.
 * (The core booking loop books here too: `withPhone` picks out the bookings T4 made.)
 */
function fakeDeployment({ status = readyStatus(), texted = false, storePhone = true, codeAnswer } = {}) {
  const state = { requests: [], bookings: [] };
  async function fetch(href, init = {}) {
    const url = new URL(href);
    const method = init.method ?? "GET";
    state.requests.push({ path: url.pathname, method, body: init.body });
    if (method === "GET" && url.pathname === "/api/status") return json(status);
    if (method === "POST" && url.pathname === "/api/owner/code") {
      return codeAnswer?.() ?? json({ error: { code: "invalid_request", message: "Texting isn't set up.", next_action: "Sign in with the access code.", details: { reason: "texting_off" } } }, 400);
    }
    if (method === "POST" && url.pathname === "/api/owner/session") {
      return json({ error: { code: "unauthorized", message: "Wrong or expired code, or it was already used.", next_action: "x" } }, 401);
    }
    const decline = /^\/api\/approvals\/([^/]+)\/decline$/.exec(url.pathname);
    if (method === "POST" && decline) {
      const b = state.bookings.find((x) => x.token === decline[1]);
      if (!b) return json({ error: { code: "booking_not_found" } }, 404);
      b.status = "cancelled";
      return json({ booking: { id: b.id, status: "cancelled" } });
    }
    if (method === "POST" && url.pathname === "/api/mcp") {
      const msg = JSON.parse(init.body);
      const reply = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
      const { name, arguments: args } = msg.params ?? {};
      if (msg.method === "tools/call" && name === "get_availability") {
        return reply({ content: [{ type: "text", text: "ok" }], structuredContent: { slots: [{ start: START, display: "Tue 10 Nov, 10:00 am EST" }] } });
      }
      if (msg.method === "tools/call" && name === "book") {
        const n = state.bookings.length + 1;
        const b = { id: `booking-${n}`, token: `token-${n}`, status: "awaiting_approval", args };
        state.bookings.push(b);
        const booking = {
          id: b.id,
          status: b.status,
          customer: { displayName: args.customer_name, approved: false, ...(storePhone && args.customer_phone ? { phone: args.customer_phone } : {}) },
          approval: { url: `${BASE}/approve/${b.token}`, expiresAt: "x" },
        };
        return reply({ content: [{ type: "text", text: "ok" }], structuredContent: { booking, texted } });
      }
    }
    return new Response("not found", { status: 404 });
  }
  const withPhone = () => state.bookings.filter((b) => b.args.customer_phone !== undefined);
  return { fetch, state, withPhone };
}

async function tRows(deployment) {
  const { rows } = await runSmoke({
    baseUrl: BASE,
    fetch: deployment.fetch,
    now: () => Date.parse("2026-11-08T12:00:00Z"),
    random: () => 0,
    print: () => {},
    checks: [texting],
  });
  return rows.filter((r) => r.item.startsWith("T"));
}

describe("pnpm smoke: texting checks", () => {
  it("loads scripts/smoke-checks/texting.mjs", async () => {
    expect(await loadSmokeChecks()).toContain(texting);
  });

  it("texting off, writes allowed: T1–T4 pass, and T4's booking is declined", async () => {
    const deployment = fakeDeployment();
    const rows = await tRows(deployment);
    expect(rows.map((r) => [r.item, r.result])).toEqual([
      ["T1", "PASS"],
      ["T2", "PASS"],
      ["T3", "PASS"],
      ["T4", "PASS"],
    ]);
    expect(rows[3].evidence).toBe("Tue 10 Nov, 10:00 am EST: texted false, customer.phone +12125550123; declined");
    expect(deployment.withPhone().map((b) => [b.status, b.args.customer_phone])).toEqual([["cancelled", "+12125550123"]]);
    const session = deployment.state.requests.find((r) => r.path === "/api/owner/session");
    expect(JSON.parse(session.body)).toEqual({ code: "000000" });
  });

  it("texting on: T2 and T4 are SKIPPED (they would text someone); nothing is booked or sent", async () => {
    const deployment = fakeDeployment({ status: readyStatus({ texting: "twilio" }) });
    const rows = await tRows(deployment);
    expect(rows.map((r) => [r.item, r.result])).toEqual([
      ["T1", "PASS"],
      ["T2", "SKIPPED"],
      ["T3", "PASS"],
      ["T4", "SKIPPED"],
    ]);
    expect(deployment.state.requests.some((r) => r.path === "/api/owner/code")).toBe(false);
    expect(deployment.withPhone()).toEqual([]);
  });

  it("production: T4 is SKIPPED (never written to)", async () => {
    const status = readyStatus({ environment: "production", database: { ...readyStatus().database, shopName: "Hart's Barbers", writesAllowed: false } });
    const rows = await tRows(fakeDeployment({ status }));
    expect(rows.find((r) => r.item === "T4")).toMatchObject({ result: "SKIPPED", evidence: "production: never written to" });
  });

  it("FAIL: a deployment without texting in /api/status, a code route that answers 200, a booking that drops the phone (still declined)", async () => {
    const deployment = fakeDeployment({
      status: readyStatus({ texting: undefined }),
      codeAnswer: () => json({ sent: true, sentTo: "•••• 0199", expiresAt: "x" }),
      storePhone: false,
    });
    const rows = await tRows(deployment);
    expect(rows.map((r) => [r.item, r.result])).toEqual([
      ["T1", "FAIL"],
      ["T2", "FAIL"],
      ["T3", "PASS"],
      ["T4", "FAIL"],
    ]);
    expect(rows[3].evidence).toBe("texted false, customer.phone undefined (declined)");
    expect(deployment.withPhone().map((b) => b.status)).toEqual(["cancelled"]);
  });
});
