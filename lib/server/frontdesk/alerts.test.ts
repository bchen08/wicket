import { afterEach, describe, expect, it, vi } from "vitest";
import type { Alert, AlertsResponse, ApiError, Booking, PoliciesResponse } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking, declineBooking } from "../consent/approvals";
import { approvalApprovePost } from "../consent/http";
import { createNotifier } from "../notify/notifier";
import { alertsGet, policiesGet, policiesPut, type OwnerOptions } from "./http";
import { UNLOCK_NEXT_ACTION } from "./owner-auth";
import { ALERTS_LIMIT, ownerBookingAction } from "./owner";
import { book, cancelBooking, getBooking, type FrontDeskDeps } from "./service";
import { approvalToken, failingNotifier, memoryDeps, NOW, PHONE_E164 } from "./test-support";

// Owner alerts end to end on the in-memory store: which changes alert the owner (booking_confirmed when the
// person approves; booking_cancelled when the agent cancels or the person declines), that every alert is
// recorded whatever happened to it, that a failed alert never touches the booking, and the owner's
// GET /api/shops/[shop]/alerts. "Now" is Mon 9 Nov 2026, noon in New York; bookings are for Sat 14 Nov.

const MIN = 60_000;
const SAT_1400 = "2026-11-14T14:00:00-05:00";
const SAT_1500 = "2026-11-14T15:00:00-05:00";
const TOKEN = "owner-token-for-tests-0123456789";
const OWNER: OwnerOptions = { getToken: () => TOKEN };

afterEach(() => {
  vi.restoreAllMocks();
});

function movableClock(start: Date): Clock & { advance(ms: number): void } {
  let at = start.getTime();
  return { now: () => new Date(at), advance: (ms) => void (at += ms) };
}

const hold = async (deps: FrontDeskDeps, start = SAT_1400, name = "Maya Lopez"): Promise<Booking> =>
  (await book(deps, "harts", { service_id: "haircut", start, customer_name: name }, "claude-ai")).booking;

const approve = async (deps: FrontDeskDeps, booking: Booking) =>
  (await approveBooking(deps, approvalToken(booking), { phone: PHONE_E164 })).booking;

/** The recorded alerts as [kind, booking id, channel, status], newest first. */
const recorded = async (deps: FrontDeskDeps) =>
  (await deps.store.listAlerts("harts", ALERTS_LIMIT)).map((a) => [a.kind, a.bookingId, a.channel, a.status]);

/** A fetch standing in for Resend: answers `status` (with Resend's error body when it isn't 2xx) and keeps every request body. */
function resend(status = 200) {
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return status < 300
      ? Response.json({ id: `email-${sent.length}` })
      : Response.json({ statusCode: status, name: "validation_error", message: "The to address is not allowed." }, { status });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("which changes alert the owner", () => {
  it("booking_confirmed when the person approves; nothing for the hold itself", async () => {
    const deps = memoryDeps();
    const held = await hold(deps);
    expect(await recorded(deps)).toEqual([]);
    const confirmed = await approve(deps, held);
    expect(await deps.store.listAlerts("harts", ALERTS_LIMIT)).toEqual<Alert[]>([
      {
        id: expect.any(String),
        shopSlug: "harts",
        bookingId: confirmed.id,
        kind: "booking_confirmed",
        channel: "log",
        recipient: null,
        status: "logged",
        error: null,
        createdAt: "2026-11-09T12:00:00-05:00",
      },
    ]);
  });

  it("booking_cancelled when the person declines", async () => {
    const deps = memoryDeps();
    const held = await hold(deps);
    await declineBooking(deps, approvalToken(held));
    expect(await recorded(deps)).toEqual([["booking_cancelled", held.id, "log", "logged"]]);
  });

  it("booking_cancelled when the agent cancels a confirmed booking, or a hold awaiting approval", async () => {
    const deps = memoryDeps();
    const confirmed = await approve(deps, await hold(deps, SAT_1400));
    const held = await hold(deps, SAT_1500, "Lee");
    await cancelBooking(deps, "harts", { booking_id: confirmed.id });
    await cancelBooking(deps, "harts", { booking_id: held.id });
    expect(await recorded(deps)).toEqual([
      ["booking_cancelled", held.id, "log", "logged"],
      ["booking_cancelled", confirmed.id, "log", "logged"],
      ["booking_confirmed", confirmed.id, "log", "logged"],
    ]);
  });

  it("nothing for the owner's own cancel, a refused cancel, or a hold that lapses", async () => {
    const clock = movableClock(NOW);
    const deps = memoryDeps({ clock });
    const confirmed = await approve(deps, await hold(deps, SAT_1400));
    const before = await recorded(deps);

    await ownerBookingAction(deps, "harts", confirmed.id, "cancel");
    await expect(cancelBooking(deps, "harts", { booking_id: confirmed.id })).rejects.toMatchObject({ code: "not_cancellable" });
    const lapsing = await hold(deps, SAT_1500);
    clock.advance(11 * MIN);
    expect((await getBooking(deps, "harts", { booking_id: lapsing.id })).booking.status).toBe("expired");

    expect(await recorded(deps)).toEqual(before);
  });
});

describe("a failed alert never touches the booking", () => {
  it("Resend refusing the email: the booking is confirmed, and the alert is recorded as failed with Resend's message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch, sent } = resend(422);
    const deps = memoryDeps({ policies: { ownerEmail: "dana@example.com" }, notifier: createNotifier({ resendApiKey: "re_test", fetch }) });
    const held = await hold(deps);
    const { booking } = await approveBooking(deps, approvalToken(held));

    expect(booking.status).toBe("confirmed");
    expect((await getBooking(deps, "harts", { booking_id: held.id })).booking.status).toBe("confirmed");
    expect(sent).toHaveLength(1);
    const [alert] = await deps.store.listAlerts("harts", ALERTS_LIMIT);
    expect(alert).toMatchObject({
      kind: "booking_confirmed",
      channel: "email",
      recipient: "dana@example.com",
      status: "failed",
      error: "Resend answered HTTP 422: The to address is not allowed.",
    });
  });

  it("a send that throws, or even a store that can't record the alert, still confirms and still cancels", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = memoryDeps({ notifier: failingNotifier("boom") });
    const broken: FrontDeskDeps = {
      ...deps,
      store: { ...deps.store, recordAlert: () => Promise.reject(new Error("database is down")) },
    };
    const confirmed = (await approveBooking(broken, approvalToken(await hold(broken)))).booking;
    expect(confirmed.status).toBe("confirmed");
    const { booking: cancelled } = await cancelBooking(broken, "harts", { booking_id: confirmed.id });
    expect(cancelled.status).toBe("cancelled");
    const events = errors.mock.calls.map((c) => JSON.parse(String(c[0])).event);
    expect(events).toEqual(["booking.notify_failed", "booking.alert_not_recorded", "booking.notify_failed", "booking.alert_not_recorded"]);
  });

  it("an error with NUL or a very long message is stored without the NUL, cut to 500 characters", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = memoryDeps({ notifier: failingNotifier(`bad\u0000${"x".repeat(1000)}`) });
    await approve(deps, await hold(deps));
    const [alert] = await deps.store.listAlerts("harts", 1);
    expect(alert.error).not.toContain("\u0000");
    expect(alert.error).toHaveLength(500);
    expect(alert.error?.startsWith("badxxx")).toBe(true);
  });
});

describe("the email", () => {
  it("goes to the shop's ownerEmail and links to /console on the origin the person approved from", async () => {
    const { fetch, sent } = resend();
    const deps = memoryDeps({ policies: { ownerEmail: "dana@example.com" }, notifier: createNotifier({ resendApiKey: "re_test", fetch }) });
    const held = await hold(deps);
    const token = approvalToken(held);
    const res = await approvalApprovePost(
      () => deps,
      new Request(`https://emergent-git-x.vercel.app/api/approvals/${token}/approve`, { method: "POST" }),
      token,
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["dana@example.com"]);
    expect(sent[0].subject).toBe("New booking: Haircut, Sat 14 Nov 2:00 pm");
    expect(sent[0].text).toContain("Customer: Maya Lopez");
    expect(sent[0].text).toContain("Booked by: claude-ai");
    expect(sent[0].text).toContain("All bookings: https://emergent-git-x.vercel.app/console");
    expect(await recorded(deps)).toEqual([["booking_confirmed", held.id, "email", "sent"]]);
  });
});

describe("GET /api/shops/[shop]/alerts", () => {
  const get = (token: string | null, shop = "harts") =>
    new Request(`http://localhost/api/shops/${shop}/alerts`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it("needs owner auth: 401 without the token, with the unlock hint; a wrong token too", async () => {
    for (const token of [null, "wrong-token"]) {
      const res = await alertsGet(() => memoryDeps(), get(token), "harts", OWNER);
      expect(res.status).toBe(401);
      const body = (await res.json()) as ApiError;
      expect(body.error).toMatchObject({ code: "unauthorized", next_action: UNLOCK_NEXT_ACTION });
    }
  });

  it("with the token: the shop and its alerts, newest first, at most 50, never cached", async () => {
    const clock = movableClock(NOW);
    const deps = memoryDeps({ clock });
    const held = await hold(deps);
    for (let i = 0; i < ALERTS_LIMIT + 5; i++) {
      await deps.store.recordAlert({
        shopSlug: "harts",
        bookingId: held.id,
        kind: i % 2 ? "booking_cancelled" : "booking_confirmed",
        channel: "log",
        recipient: null,
        status: "logged",
        error: null,
      });
      clock.advance(i % 3 === 0 ? MIN : 0); // some share a created_at; id breaks the tie
    }
    const res = await alertsGet(() => deps, get(TOKEN), "harts", OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as AlertsResponse;
    expect(body.shop).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
    expect(body.alerts).toHaveLength(ALERTS_LIMIT);
    const ids = body.alerts.map((a) => Number(a.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids[0]).toBe(ALERTS_LIMIT + 5);
  });

  it("is empty for a shop without alerts, and 404 for an unknown shop", async () => {
    const empty = (await (await alertsGet(() => memoryDeps(), get(TOKEN), "harts", OWNER)).json()) as AlertsResponse;
    expect(empty.alerts).toEqual([]);
    const res = await alertsGet(() => memoryDeps(), get(TOKEN, "nope"), "nope", OWNER);
    expect(res.status).toBe(404);
  });
});

describe("Policies.ownerEmail (owner routes)", () => {
  const put = (body: unknown) =>
    new Request("http://localhost/api/shops/harts/policies", {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("PUT stores it trimmed, GET shows it, null removes it; alerts then go to it", async () => {
    const deps = memoryDeps();
    const saved = (await (await policiesPut(() => deps, put({ ownerEmail: "  dana@example.com " }), "harts", OWNER)).json()) as PoliciesResponse;
    expect(saved.policies.ownerEmail).toBe("dana@example.com");
    const getRequest = new Request("http://localhost/api/shops/harts/policies", { headers: { authorization: `Bearer ${TOKEN}` } });
    const read = (await (await policiesGet(() => deps, getRequest, "harts", OWNER)).json()) as PoliciesResponse;
    expect(read.policies).toMatchObject({ ownerEmail: "dana@example.com", phone: "+1 212-555-0142" });

    const cleared = (await (await policiesPut(() => deps, put({ ownerEmail: null }), "harts", OWNER)).json()) as PoliciesResponse;
    expect(cleared.policies.ownerEmail).toBeNull();
  });

  it("refuses, with a clear error: no @, longer than 254 characters, NUL, not a string", async () => {
    const message = "ownerEmail must be an email address (with an @) of at most 254 characters, or null to remove it.";
    const cases: [unknown, string][] = [
      ["dana.example.com", message],
      ["", message],
      [`${"a".repeat(243)}@example.com`, message],
      ["dana\u0000@example.com", "ownerEmail can't contain the NUL character (U+0000)."],
      [42, message],
    ];
    for (const [ownerEmail, expected] of cases) {
      const res = await policiesPut(() => memoryDeps(), put({ ownerEmail }), "harts", OWNER);
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiError;
      expect(body.error).toMatchObject({ code: "invalid_request", message: expected, details: { field: "ownerEmail" } });
    }
    // 254 characters exactly is fine.
    const longest = `${"a".repeat(242)}@example.com`;
    expect(longest).toHaveLength(254);
    expect((await policiesPut(() => memoryDeps(), put({ ownerEmail: longest }), "harts", OWNER)).status).toBe(200);
  });
});
