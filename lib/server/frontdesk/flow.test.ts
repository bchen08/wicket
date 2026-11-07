import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiError,
  BookingDetailResponse,
  BookResult,
  CancelResult,
  GetAvailabilityResult,
  GetPoliciesResult,
  OwnerBookingActionResponse,
  PoliciesResponse,
  Slot,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { bookingActionPost, bookingDetailGet, policiesGet, policiesPut, type OwnerOptions } from "./http";
import { createFrontDeskMcpHandler } from "./mcp";
import { SEED } from "./memory-store";
import type { FrontDeskDeps } from "./service";
import { memoryDeps } from "./test-support";

// Issue #8's "Done when" list, end to end: the real MCP handler (what /api/mcp mounts) and the real
// owner HTTP handlers (what the /api/shops/* route files call) over ONE deps object, the way
// production shares getFrontDeskDeps(). In-memory store, Hart's seeded rules, and a clock the tests
// move. "Now" starts at Tue 10 Nov 2026, 10:20 in New York (Hart's is open Tue–Sat, 9–5, lunch 12:00–12:30).

/** A clock the test can move. */
type MovableClock = Clock & { set(iso: string): void };
function movableClock(iso: string): MovableClock {
  let at = new Date(iso);
  return {
    now: () => new Date(at.getTime()),
    set(next) {
      at = new Date(next);
    },
  };
}

const TUE_1020 = "2026-11-10T10:20:00-05:00";
const TODAY = { from: "2026-11-10T00:00:00-05:00", to: "2026-11-11T00:00:00-05:00" };
const THURSDAY = { from: "2026-11-12T00:00:00-05:00", to: "2026-11-13T00:00:00-05:00" };
const THU_1000 = "2026-11-12T10:00:00-05:00";
const TUE_1300 = "2026-11-10T13:00:00-05:00";
const PHONE = "+1 212-555-0142";

const TOKEN = "flow-test-owner-token-0123456789";
const OWNER: OwnerOptions = { getToken: () => TOKEN };

let clock: MovableClock;
let deps: FrontDeskDeps;
beforeEach(() => {
  clock = movableClock(TUE_1020);
  deps = memoryDeps({ clock });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// Both doors resolve deps per request, like the routes passing getFrontDeskDeps.
const getDeps = () => deps;
const mcp = createFrontDeskMcpHandler(getDeps);

// ---- MCP over stateless Streamable HTTP (as in mcp.test.ts) ----

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

let nextId = 1;
async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await mcp(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  // The response is either plain JSON or a single SSE "message" event.
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
  const msg = JSON.parse(json) as { result?: T; error?: unknown };
  if (msg.error) throw new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`);
  return msg.result as T;
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  rpc<ToolResult>("tools/call", { name, arguments: args });

/** A successful tool call's structuredContent. */
async function ok<T>(name: string, args: Record<string, unknown> = {}): Promise<{ data: T; text: string }> {
  const result = await callTool(name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return { data: result.structuredContent as T, text: result.content[0].text };
}

/** A failed tool call's ApiError envelope. */
async function fails(name: string, args: Record<string, unknown>): Promise<ApiError["error"]> {
  const result = await callTool(name, args);
  expect(result.isError).toBe(true);
  return (JSON.parse(result.content[0].text) as ApiError).error;
}

const key = () => crypto.randomUUID();

const availability = async (window: { from: string; to: string }, serviceId = "haircut") =>
  ok<GetAvailabilityResult>("get_availability", { service_id: serviceId, ...window, limit: 50 });

const bookArgs = (start: string, idempotencyKey = key(), customer = "E2E Maya") => ({
  service_id: "haircut",
  start,
  customer_name: customer,
  idempotency_key: idempotencyKey,
});

// ---- Owner routes ----

function ownerRequest(method: string, path: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost/api/shops/harts${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const res = await response;
  const body = (await res.json()) as T;
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
}

const putPolicies = (body: unknown) =>
  json<PoliciesResponse>(policiesPut(getDeps, ownerRequest("PUT", "/policies", body), "harts", OWNER));

const bookingDetail = (id: string) =>
  json<BookingDetailResponse>(bookingDetailGet(getDeps, ownerRequest("GET", `/bookings/${id}`), "harts", id, OWNER));

const markNoShow = (id: string) =>
  json<OwnerBookingActionResponse>(
    bookingActionPost(getDeps, ownerRequest("POST", `/bookings/${id}/no-show`), "harts", id, "mark_no_show", OWNER),
  );

const local = (slot: Slot) => slot.start.slice(11, 16);
const ms = (iso: string) => Date.parse(iso);

describe("Done when (issue #8), through the MCP and owner handlers over shared deps", () => {
  it("1. MCP get_policies returns Hart's seeded policies", async () => {
    const { data, text } = await ok<GetPoliciesResult>("get_policies");
    expect(data.shop).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
    expect(data.policies).toMatchObject({
      leadTimeMin: 120,
      horizonDays: 30,
      depositHorizonDays: 6,
      cancelWindowHours: 24,
      paused: false,
      phone: PHONE,
    });
    // Deposit held at booking; captured on a no-show or a cancellation inside 24 hours; released otherwise.
    expect(data.policies.depositRule).toMatch(/hold the deposit on your card at booking/);
    expect(data.policies.lateCancelRule).toMatch(/at least 24 hours .* released.*within 24 hours .* keep the deposit/);
    expect(data.policies.noShowRule).toMatch(/don't show up, we keep the deposit.*released/);
    expect(data.policies).toEqual(SEED.policies.harts);
    // The text relays the same rules.
    expect(text).toMatch(/at least 2 hours ahead/);
    expect(text).toMatch(/24 hours/);
    expect(text).toContain(PHONE);
  });

  it("2. MCP get_availability skips lunch and anything inside 2 hours", async () => {
    // Today, 10:20: now + 2 h = 12:20, rounded up to the grid = 12:30 (12:00–12:30 is lunch anyway).
    const today = await availability(TODAY);
    expect(today.data.slots[0].start).toBe("2026-11-10T12:30:00-05:00");
    for (const slot of today.data.slots) {
      expect(ms(slot.start)).toBeGreaterThanOrEqual(ms("2026-11-10T12:30:00-05:00"));
    }
    expect(today.data.slots.map(local)).toEqual([
      "12:30", "12:45", "13:00", "13:15", "13:30", "13:45", "14:00", "14:15", "14:30",
      "14:45", "15:00", "15:15", "15:30", "15:45", "16:00", "16:15", "16:30",
    ]);
    expect(today.text).toMatch(/12:30 pm/);

    // A whole day (Thursday): mornings and afternoons, but no 30-minute haircut touching 12:00–12:30.
    const thursday = await availability(THURSDAY);
    const starts = thursday.data.slots.map(local);
    expect(starts).toContain("09:00");
    expect(starts).toContain("11:30"); // ends at 12:00
    expect(starts).toContain("12:30");
    for (const slot of thursday.data.slots) {
      const overlapsLunch = ms(slot.start) < ms("2026-11-12T12:30:00-05:00") && ms(slot.end) > ms("2026-11-12T12:00:00-05:00");
      expect(overlapsLunch, slot.start).toBe(false);
    }

    // And book refuses a start inside the lead time.
    const err = await fails("book", bookArgs("2026-11-10T11:00:00-05:00"));
    expect(err.code).toBe("too_soon");
    expect(err.details?.earliest).toBe("2026-11-10T12:30:00-05:00");
  });

  it("3. MCP book with an idempotency key, and replaying it returns the same booking", async () => {
    const args = bookArgs(THU_1000);
    const first = await ok<BookResult>("book", args);
    expect(first.data.booking).toMatchObject({ start: THU_1000, status: "confirmed", serviceId: "haircut" });

    const replay = await ok<BookResult>("book", args);
    expect(replay.data.booking).toEqual(first.data.booking);
    expect(replay.text).toMatch(/replayed/);

    const stored = await deps.store.listBookings("harts", { start: new Date(THURSDAY.from), end: new Date(THURSDAY.to) });
    expect(stored.map((b) => b.id)).toEqual([first.data.booking.id]);

    const detail = await bookingDetail(first.data.booking.id);
    expect(detail.booking).toEqual(first.data.booking);
    expect(detail.events.map((e) => [e.type, e.actor])).toEqual([["booked", "agent"]]);

    // The same key with other arguments is refused.
    const conflict = await fails("book", { ...args, customer_name: "E2E Someone Else" });
    expect(conflict.code).toBe("idempotency_conflict");
  });

  it("4. MCP cancel more than 24 hours ahead → cancelled, depositEffect released, and the slot is offered again", async () => {
    const { data } = await ok<BookResult>("book", bookArgs(THU_1000));
    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).not.toContain(THU_1000);

    // 10:20 Tue → 10:00 Thu is 47 h 40 min ahead.
    const cancelArgs = { booking_id: data.booking.id, idempotency_key: key() };
    const cancelled = await ok<CancelResult>("cancel", cancelArgs);
    expect(cancelled.data).toEqual({
      booking: { ...data.booking, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    });
    expect(cancelled.text).toMatch(/released/);

    // A retry with the same key replays; get_booking agrees.
    expect((await ok<CancelResult>("cancel", cancelArgs)).data).toEqual(cancelled.data);
    expect((await ok<{ booking: { status: string } }>("get_booking", { booking_id: data.booking.id })).data.booking.status).toBe(
      "cancelled",
    );

    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).toContain(THU_1000);
  });

  it("5. with the owner token, paused = true → get_availability returns nothing and book returns paused; paused = false restores it", async () => {
    const paused = await putPolicies({ paused: true });
    expect(paused.policies).toEqual({ ...SEED.policies.harts, paused: true });

    const none = await availability(THURSDAY);
    expect(none.data).toEqual({ slots: [], truncated: false });
    expect(none.text).toMatch(/isn't taking bookings/);
    expect(none.text).toContain(PHONE);

    const err = await fails("book", bookArgs(THU_1000));
    expect(err.code).toBe("paused");
    expect(err.details).toEqual({ phone: PHONE });
    expect(err.next_action).toContain(PHONE);
    expect((await ok<GetPoliciesResult>("get_policies")).data.policies.paused).toBe(true);

    const resumed = await putPolicies({ paused: false });
    expect(resumed.policies.paused).toBe(false);
    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).toContain(THU_1000);
    expect((await ok<BookResult>("book", bookArgs(THU_1000))).data.booking.status).toBe("confirmed");
  });

  it("6. with the owner token, marking a past booking no_show → depositEffect captured", async () => {
    const { data } = await ok<BookResult>("book", bookArgs(TUE_1300));
    clock.set("2026-11-10T14:00:00-05:00");

    const result = await markNoShow(data.booking.id);
    expect(result).toEqual({
      booking: { ...data.booking, status: "no_show" },
      depositEffect: "captured",
      depositCollected: false,
    });
  });

  it("7. GET /api/shops/harts/bookings/[id] shows the events for each step", async () => {
    // book → cancel (agent, > 24 h ahead)
    const a = (await ok<BookResult>("book", bookArgs(THU_1000, key(), "E2E Cancel"))).data.booking;
    await ok<CancelResult>("cancel", { booking_id: a.id, idempotency_key: key() });
    const cancelled = await bookingDetail(a.id);
    expect(cancelled.booking.status).toBe("cancelled");
    expect(cancelled.events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["cancelled", "agent"],
    ]);
    expect(cancelled.events[0].data).toMatchObject({ status: "confirmed" });
    expect(cancelled.events[1].data).toEqual({ from: "confirmed", to: "cancelled", depositEffect: "released", depositCollected: false });

    // book → (after the start) owner no-show
    const b = (await ok<BookResult>("book", bookArgs(TUE_1300, key(), "E2E No-show"))).data.booking;
    clock.set("2026-11-10T14:00:00-05:00");
    await markNoShow(b.id);
    const noShow = await bookingDetail(b.id);
    expect(noShow.booking.status).toBe("no_show");
    expect(noShow.events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["no_show", "owner"],
    ]);
    expect(noShow.events[1].data).toEqual({ from: "confirmed", to: "no_show", depositEffect: "captured", depositCollected: false });

    // Oldest first, stamped with the store's clock.
    expect(noShow.events.map((e) => e.at)).toEqual(["2026-11-10T10:20:00-05:00", "2026-11-10T14:00:00-05:00"]);
    for (const { events } of [cancelled, noShow]) {
      expect(events.every((e, i) => i === 0 || ms(events[i - 1].at) <= ms(e.at))).toBe(true);
    }
  });

  it("8. owner routes answer 401 without the token and 503 when OWNER_API_TOKEN is unset", async () => {
    const noToken = await policiesGet(getDeps, ownerRequest("GET", "/policies", undefined, null), "harts", OWNER);
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(((await noToken.json()) as ApiError).error.code).toBe("unauthorized");

    const wrong = await policiesPut(
      getDeps,
      ownerRequest("PUT", "/policies", { paused: true }, "Bearer not-the-owner-token-at-all"),
      "harts",
      OWNER,
    );
    expect(wrong.status).toBe(401);
    expect((await ok<GetPoliciesResult>("get_policies")).data.policies.paused).toBe(false);

    const unset = await policiesGet(getDeps, ownerRequest("GET", "/policies"), "harts", { getToken: () => undefined });
    expect(unset.status).toBe(503);
    const body = (await unset.json()) as ApiError;
    expect(body.error.message).toMatch(/OWNER_API_TOKEN/);
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // The default reads process.env.OWNER_API_TOKEN, like the route files.
    vi.stubEnv("OWNER_API_TOKEN", undefined);
    expect((await policiesGet(getDeps, ownerRequest("GET", "/policies"), "harts")).status).toBe(503);
    vi.stubEnv("OWNER_API_TOKEN", TOKEN);
    expect((await policiesGet(getDeps, ownerRequest("GET", "/policies"), "harts")).status).toBe(200);
  });
});
