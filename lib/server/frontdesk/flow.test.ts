import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiError,
  ApprovalView,
  ApproveResponse,
  Booking,
  BookingDetailResponse,
  BookingsResponse,
  BookResult,
  CancelResult,
  DeclineResponse,
  GetAvailabilityResult,
  GetBookingResult,
  GetPoliciesResult,
  OwnerBookingActionResponse,
  PoliciesResponse,
  Slot,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approvalApprovePost, approvalDeclinePost, approvalGet } from "../consent/http";
import { bookingActionPost, bookingDetailGet, bookingsResponse, policiesGet, policiesPut, type OwnerOptions } from "./http";
import { createFrontDeskMcpHandler } from "./mcp";
import { NOT_SET_UP_NEXT_ACTION, UNLOCK_NEXT_ACTION } from "./owner-auth";
import { SEED } from "./memory-store";
import type { FrontDeskDeps } from "./service";
import { approvalToken, customerOf, memoryDeps, PHONE_E164, recordingNotifier } from "./test-support";

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

const availability = async (window: { from: string; to: string }, serviceId = "haircut") =>
  ok<GetAvailabilityResult>("get_availability", { service_id: serviceId, ...window, limit: 50 });

const bookArgs = (start: string, customer = "E2E Maya") => ({
  service_id: "haircut",
  start,
  customer_name: customer,
});

// ---- Owner routes ----

function ownerRequest(method: string, path: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  // The same origin as the MCP door's links (deps.baseUrl), so the owner sees the same approval link.
  return new Request(`http://localhost:3000/api/shops/harts${path}`, {
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

// ---- The approval page's API (Ring 1b) ----

/** A POST from the approval page. No Origin header is needed. */
function pageRequest(path: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost:3000/api/approvals${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const approvalView = (token: string) => json<ApprovalView>(approvalGet(getDeps, token));
const approveWith = (token: string, body?: unknown, status = 200) =>
  json<ApproveResponse>(approvalApprovePost(getDeps, pageRequest(`/${token}/approve`, body), token), status);

/** The person approves `booking` (book's result) on the page, giving their phone number. */
async function approveOnPage(booking: Booking, phone = PHONE_E164): Promise<Booking> {
  return (await approveWith(approvalToken(booking), { phone })).booking;
}

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

  it("3. MCP book places one hold; booking the same time again is slot_taken (no double booking on a retry)", async () => {
    const args = bookArgs(THU_1000);
    const first = await ok<BookResult>("book", args);
    // Ring 1b: a hold awaiting the person's approval, with the link to send them.
    expect(first.data.booking).toMatchObject({
      start: THU_1000,
      status: "awaiting_approval",
      serviceId: "haircut",
      approval: { url: expect.stringMatching(/^http:\/\/localhost:3000\/approve\//), expiresAt: "2026-11-10T10:30:00-05:00" },
    });

    const again = await fails("book", args);
    expect(again.code).toBe("slot_taken");

    const stored = await deps.store.listBookings("harts", { start: new Date(THURSDAY.from), end: new Date(THURSDAY.to) });
    expect(stored.map((b) => b.id)).toEqual([first.data.booking.id]);

    const detail = await bookingDetail(first.data.booking.id);
    expect(detail.booking).toEqual(first.data.booking); // the same link, for the owner to copy
    expect(detail.events.map((e) => [e.type, e.actor])).toEqual([["booked", "agent"]]);
    expect((deps.notifier as ReturnType<typeof recordingNotifier>).alerts).toEqual([]);
  });

  it("4. MCP cancel more than 24 hours ahead → cancelled, depositEffect released, and the slot is offered again", async () => {
    const { data } = await ok<BookResult>("book", bookArgs(THU_1000));
    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).not.toContain(THU_1000);
    const approved = await approveOnPage(data.booking);
    expect(approved.status).toBe("confirmed");

    // 10:20 Tue → 10:00 Thu is 47 h 40 min ahead.
    const cancelArgs = { booking_id: data.booking.id };
    const cancelled = await ok<CancelResult>("cancel", cancelArgs);
    expect(cancelled.data).toEqual({
      booking: { ...approved, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    });
    expect(cancelled.text).toMatch(/released/);

    // A retry can't cancel twice: it's not_cancellable now. get_booking agrees.
    const retry = await fails("cancel", cancelArgs);
    expect(retry.code).toBe("not_cancellable");
    expect(retry.details).toMatchObject({ status: "cancelled" });
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
    expect((await ok<BookResult>("book", bookArgs(THU_1000))).data.booking.status).toBe("awaiting_approval");
  });

  it("6. with the owner token, marking a past booking no_show → depositEffect captured", async () => {
    const { data } = await ok<BookResult>("book", bookArgs(TUE_1300));
    const approved = await approveOnPage(data.booking);
    clock.set("2026-11-10T14:00:00-05:00");

    const result = await markNoShow(data.booking.id);
    expect(result).toEqual({
      booking: { ...approved, status: "no_show" },
      depositEffect: "captured",
      depositCollected: false,
    });
  });

  it("7. GET /api/shops/harts/bookings/[id] shows the events for each step", async () => {
    // book → approve (the person) → cancel (agent, > 24 h ahead)
    const a = (await ok<BookResult>("book", bookArgs(THU_1000, "E2E Cancel"))).data.booking;
    await approveOnPage(a);
    await ok<CancelResult>("cancel", { booking_id: a.id });
    const cancelled = await bookingDetail(a.id);
    expect(cancelled.booking.status).toBe("cancelled");
    expect(cancelled.events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["approved", "customer"],
      ["cancelled", "agent"],
    ]);
    expect(cancelled.events[0].data).toEqual({ status: "awaiting_approval", agentName: "unknown agent" });
    expect(cancelled.events[1].data).toEqual({
      from: "awaiting_approval",
      to: "confirmed",
      depositEffect: "none",
      depositCollected: false,
    });
    expect(cancelled.events[2].data).toEqual({ from: "confirmed", to: "cancelled", depositEffect: "released", depositCollected: false });

    // book → approve → (after the start) owner no-show
    const b = (await ok<BookResult>("book", bookArgs(TUE_1300, "E2E No-show"))).data.booking;
    await approveOnPage(b);
    clock.set("2026-11-10T14:00:00-05:00");
    await markNoShow(b.id);
    const noShow = await bookingDetail(b.id);
    expect(noShow.booking.status).toBe("no_show");
    expect(noShow.events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["approved", "customer"],
      ["no_show", "owner"],
    ]);
    expect(noShow.events[2].data).toEqual({ from: "confirmed", to: "no_show", depositEffect: "captured", depositCollected: false });

    // Oldest first, stamped with the store's clock.
    expect(noShow.events.map((e) => e.at)).toEqual([
      "2026-11-10T10:20:00-05:00",
      "2026-11-10T10:20:00-05:00",
      "2026-11-10T14:00:00-05:00",
    ]);
    for (const { events } of [cancelled, noShow]) {
      expect(events.every((e, i) => i === 0 || ms(events[i - 1].at) <= ms(e.at))).toBe(true);
    }
  });

  it("8. owner routes answer 401 without the token, and when OWNER_API_TOKEN is unset", async () => {
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
    expect(unset.status).toBe(401);
    const body = (await unset.json()) as ApiError;
    expect(body.error).toMatchObject({ code: "unauthorized", next_action: NOT_SET_UP_NEXT_ACTION });
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // The bookings list (what the console reads) says to unlock.
    const locked = await bookingsResponse(getDeps, ownerRequest("GET", "/bookings", undefined, null), "harts", OWNER);
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as ApiError).error.next_action).toBe(UNLOCK_NEXT_ACTION);

    // The default reads process.env.OWNER_API_TOKEN, like the route files.
    vi.stubEnv("OWNER_API_TOKEN", undefined);
    expect((await policiesGet(getDeps, ownerRequest("GET", "/policies"), "harts")).status).toBe(401);
    vi.stubEnv("OWNER_API_TOKEN", TOKEN);
    expect((await policiesGet(getDeps, ownerRequest("GET", "/policies"), "harts")).status).toBe(200);
  });
});

// Issue #15's "Done when" list for Ring 1b, end to end over the same shared deps: the MCP book tool, the
// approval page's API (what /approve/[token] calls), MCP get_booking and the owner's bookings list.
// Opening the link and approving is the consent (no phone code until Ring 1c). "Now" is Tue 10 Nov 2026,
// 10:20 in New York; the hold lasts until 10:30.
describe("Done when (issue #15): consent, through MCP, the approval API and the owner routes over shared deps", () => {
  const bookingsList = () => json<BookingsResponse>(bookingsResponse(getDeps, ownerRequest("GET", "/bookings"), "harts", OWNER));

  it("book → link → approve (with a phone) → get_booking confirmed and approved → the owner's list shows the customer", async () => {
    const { data, text } = await ok<BookResult>("book", bookArgs(THU_1000, "Maya Lopez"));
    const booking = data.booking;
    expect(booking.status).toBe("awaiting_approval");
    expect(text).toContain(`Send Maya Lopez this link to approve: ${booking.approval!.url}. Then call get_booking to check the status.`);
    const token = approvalToken(booking);

    // The page loads: pending, with the shop's rules.
    const view = await approvalView(token);
    expect(view).toMatchObject({
      status: "pending",
      shop: { slug: "harts", name: "Hart's Barbers" },
      serviceName: "Haircut",
      start: THU_1000,
      priceCents: 3500,
      depositCents: 1000,
      policies: { cancelWindowHours: 24, depositRule: SEED.policies.harts.depositRule },
      agentName: "unknown agent",
      customerName: "Maya Lopez",
      expiresAt: "2026-11-10T10:30:00-05:00",
    });
    expect(view).not.toHaveProperty("codeSentTo");

    // While it's pending, get_booking and the owner's list carry the same link book returned.
    const pending = await ok<GetBookingResult>("get_booking", { booking_id: booking.id });
    expect(pending.data.booking.approval).toEqual(booking.approval);
    expect(pending.text).toContain(`Waiting for Maya Lopez to approve with this link: ${booking.approval!.url}`);
    expect((await bookingsList()).bookings.find((b) => b.id === booking.id)?.approval).toEqual(booking.approval);

    // The person approves on the page, typing their number with separators.
    const approved = await approveWith(token, { phone: "+1 (401) 555-0123" });
    expect(approved.booking).toMatchObject({
      id: booking.id,
      status: "confirmed",
      customer: customerOf("Maya Lopez", true, PHONE_E164),
    });
    expect(approved.booking).not.toHaveProperty("approval");
    expect((await approvalView(token)).status).toBe("approved");

    const fetched = await ok<GetBookingResult>("get_booking", { booking_id: booking.id });
    expect(fetched.data.booking).toEqual(approved.booking);
    expect(fetched.text).toContain("Maya Lopez approved it. It is confirmed.");

    const list = await bookingsList();
    expect(list.bookings.find((b) => b.id === booking.id)).toEqual(approved.booking);
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await bookingDetail(booking.id)).events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["approved", "customer"],
    ]);
    // The owner hears about it exactly once, when it was approved.
    const alerts = (deps.notifier as ReturnType<typeof recordingNotifier>).alerts;
    expect(alerts.map((b) => [b.id, b.status])).toEqual([[booking.id, "confirmed"]]);
  });

  it("a second agent booking the same slot while it's on hold gets slot_taken", async () => {
    await ok<BookResult>("book", bookArgs(THU_1000, "First Agent's Person"));
    const err = await fails("book", bookArgs(THU_1000, "Second Agent's Person"));
    expect(err.code).toBe("slot_taken");
    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).not.toContain(THU_1000);
  });

  it("after 10 minutes the hold is expired: the slot is offered and bookable again, and the link is closed", async () => {
    const held = (await ok<BookResult>("book", bookArgs(THU_1000))).data.booking;
    const token = approvalToken(held);
    clock.set("2026-11-10T10:30:00-05:00");

    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).toContain(THU_1000);
    const again = await ok<BookResult>("book", bookArgs(THU_1000, "E2E Next"));
    expect(again.data.booking).toMatchObject({ start: THU_1000, status: "awaiting_approval" });

    expect((await ok<GetBookingResult>("get_booking", { booking_id: held.id })).data.booking.status).toBe("expired");
    expect((await approvalView(token)).status).toBe("expired");
    const err = await approveWith(token, { phone: PHONE_E164 }, 410) as unknown as ApiError;
    expect(err.error.code).toBe("approval_expired");
    expect(err.error.next_action).toBe("Ask your agent to book again.");
    expect((await bookingDetail(held.id)).events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
  });

  it("declining on the page cancels the booking and frees the slot", async () => {
    const held = (await ok<BookResult>("book", bookArgs(THU_1000))).data.booking;
    const token = approvalToken(held);
    const declined = await json<DeclineResponse>(approvalDeclinePost(getDeps, pageRequest(`/${token}/decline`), token));
    expect(declined.booking).toMatchObject({ id: held.id, status: "cancelled", customer: { approved: false } });
    expect((await availability(THURSDAY)).data.slots.map((s) => s.start)).toContain(THU_1000);
    expect((await approvalView(token)).status).toBe("declined");
    expect((deps.notifier as ReturnType<typeof recordingNotifier>).alerts).toEqual([]);
  });

  it("approving with no body (no phone): confirmed and approved, no customer.phone", async () => {
    const held = (await ok<BookResult>("book", bookArgs(THU_1000))).data.booking;
    const approved = await approveWith(approvalToken(held));
    expect(approved.booking).toMatchObject({ id: held.id, status: "confirmed", customer: { approved: true } });
    expect(approved.booking.customer).not.toHaveProperty("phone");
    const fetched = await ok<GetBookingResult>("get_booking", { booking_id: held.id });
    expect(fetched.text).toContain("E2E Maya approved it. It is confirmed.");
  });

  it("the approval POSTs need no Origin header: any origin (or none) works", async () => {
    for (const origin of [null, "https://elsewhere.example"]) {
      const held = (await ok<BookResult>("book", bookArgs(THU_1000))).data.booking;
      const token = approvalToken(held);
      const request = new Request(`http://localhost:3000/api/approvals/${token}/decline`, {
        method: "POST",
        headers: origin ? { origin } : {},
      });
      const declined = await json<DeclineResponse>(approvalDeclinePost(getDeps, request, token));
      expect(declined.booking.status, `decline from ${origin}`).toBe("cancelled");
    }
    const held = (await ok<BookResult>("book", bookArgs(THU_1000))).data.booking;
    const token = approvalToken(held);
    const request = new Request(`http://localhost:3000/api/approvals/${token}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
      body: JSON.stringify({}),
    });
    expect((await json<ApproveResponse>(approvalApprovePost(getDeps, request, token))).booking.status).toBe("confirmed");
  });
});
