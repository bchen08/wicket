import { describe, expect, it } from "vitest";
import type { ApproveResponse, Booking, BookingsResponse, GetBookingResult } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking, declineBooking, getApprovalView } from "../consent/approvals";
import { approvalApprovePost } from "../consent/http";
import { decide, DEPOSIT_PAY_MINUTES, needsDeposit } from "../engine/lifecycle";
import { createFrontDeskDeps, paymentsFrom } from "../frontdesk/deps";
import { FrontDeskError } from "../frontdesk/errors";
import { createFrontDeskMcpHandler } from "../frontdesk/mcp";
import { ownerBookingAction } from "../frontdesk/owner";
import { book, cancelBooking, getAvailability, getBooking, listShopBookings, type FrontDeskDeps } from "../frontdesk/service";
import { getStatus } from "../frontdesk/status";
import { approvalToken, memoryDeps, NOW, recordingNotifier, TEST_BASE_URL } from "../frontdesk/test-support";
import { stubPayments, type StubPayments } from "./stub-payments";

// Deposits through a stubbed Stripe (stub-payments.ts): who needs one, approve → awaiting_deposit, paid →
// confirmed, unpaid → expired, and the money moving on each transition. NOW is Mon 9 Nov 2026, noon in
// New York; Hart's takes deposit services up to 6 days ahead and its cancellation window is 24 hours.

const SHOP = "harts";
/** 5 days ahead: inside the 6-day deposit horizon, outside the 24-hour cancellation window. */
const SAT_1400 = "2026-11-14T14:00:00-05:00";
/** 22 hours ahead: inside the cancellation window. */
const TUE_1000 = "2026-11-10T10:00:00-05:00";
const MIN = 60_000;
const PAY_BY = "2026-11-09T12:30:00-05:00";

function movableClock(start: Date = NOW): Clock & { advance(ms: number): void; set(iso: string): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => (t += ms),
    set: (iso) => (t = new Date(iso).getTime()),
  };
}

/** Deps with deposits on (a stubbed Stripe) unless `payments` is null. */
function setup(options: { payments?: StubPayments | null } = {}) {
  const clock = movableClock();
  const notifier = recordingNotifier();
  const stripe = options.payments === undefined ? stubPayments() : options.payments;
  const deps = memoryDeps({ clock, notifier, payments: stripe });
  return { deps, clock, notifier, stripe: stripe as StubPayments };
}

async function hold(deps: FrontDeskDeps, start = SAT_1400, service = "haircut"): Promise<Booking> {
  return (await book(deps, SHOP, { service_id: service, start, customer_name: "Maya Lopez" }, "Claude")).booking;
}

async function approve(deps: FrontDeskDeps, booking: Booking): Promise<Booking> {
  return (await approveBooking(deps, approvalToken(booking), {})).booking;
}

async function read(deps: FrontDeskDeps, id: string): Promise<Booking> {
  return (await getBooking(deps, SHOP, { booking_id: id })).booking;
}

/** A Haircut the person approved and paid for: confirmed, deposit held. */
async function paidBooking(deps: FrontDeskDeps, stripe: StubPayments, start = SAT_1400): Promise<Booking> {
  const waiting = await approve(deps, await hold(deps, start));
  stripe.pay(stripe.onlySession().id);
  return read(deps, waiting.id);
}

async function events(deps: FrontDeskDeps, id: string) {
  return (await deps.store.listEvents(id)).map((e) => [e.type, e.actor, e.data]);
}

async function isFree(deps: FrontDeskDeps, start: string): Promise<boolean> {
  const to = new Date(new Date(start).getTime() + 60 * MIN).toISOString();
  const { slots } = await getAvailability(deps, SHOP, { service_id: "haircut", from: start, to });
  return slots.some((s) => Date.parse(s.start) === Date.parse(start));
}

describe("needsDeposit: a deposit service within the deposit horizon", () => {
  const policies = { depositHorizonDays: 6 };
  const tz = "America/New_York";

  it("needs one for a deposit service starting before now + depositHorizonDays, not at or after it", () => {
    expect(needsDeposit({ depositCents: 1000, start: SAT_1400 }, NOW, policies, tz)).toBe(true);
    expect(needsDeposit({ depositCents: 1000, start: "2026-11-15T11:45:00-05:00" }, NOW, policies, tz)).toBe(true);
    expect(needsDeposit({ depositCents: 1000, start: "2026-11-15T12:00:00-05:00" }, NOW, policies, tz)).toBe(false);
    expect(needsDeposit({ depositCents: 1000, start: SAT_1400 }, NOW, { depositHorizonDays: 2 }, tz)).toBe(false);
  });

  it("never for a service without a deposit", () => {
    expect(needsDeposit({ depositCents: 0, start: SAT_1400 }, NOW, policies, tz)).toBe(false);
  });

  it("counts calendar days in the shop's zone, across the clock change", () => {
    // Sat 31 Oct noon EDT + 6 days = Fri 6 Nov noon EST (DST ended on Sun 1 Nov): 145 hours, not 144.
    const now = new Date("2026-10-31T12:00:00-04:00");
    expect(needsDeposit({ depositCents: 1000, start: "2026-11-06T11:30:00-05:00" }, now, policies, tz)).toBe(true);
    expect(needsDeposit({ depositCents: 1000, start: "2026-11-06T12:00:00-05:00" }, now, policies, tz)).toBe(false);
  });
});

describe("decide: deposit rows", () => {
  const policies = { cancelWindowHours: 24, phone: null };
  const base = { id: "3f1c8a52-6d0e-4b8f-9a77-2c5d1e9b0a41", start: SAT_1400, depositCents: 1000 };
  const approveBy = new Date(NOW.getTime() + 10 * MIN);

  it("approve → awaiting_deposit when a deposit is required, else confirmed", () => {
    const hold = { ...base, status: "awaiting_approval" as const, approveBy };
    expect(decide({ ...hold, depositRequired: true }, { type: "approve", actor: "customer" }, NOW, policies)).toEqual({
      nextStatus: "awaiting_deposit",
      depositEffect: "none",
    });
    expect(decide(hold, { type: "approve", actor: "customer" }, NOW, policies)).toEqual({ nextStatus: "confirmed", depositEffect: "none" });
  });

  it("an unpaid deposit expires (released) at payBy, not before; paying confirms it any time", () => {
    const payBy = new Date(NOW.getTime() + 30 * MIN);
    const waiting = { ...base, status: "awaiting_deposit" as const, payBy };
    const before = decide(waiting, { type: "expire", actor: "system" }, new Date(payBy.getTime() - 1), policies);
    expect(before).toBeInstanceOf(FrontDeskError);
    expect(decide(waiting, { type: "expire", actor: "system" }, payBy, policies)).toEqual({ nextStatus: "expired", depositEffect: "released" });
    expect(decide(waiting, { type: "confirm_deposit", actor: "system" }, new Date(payBy.getTime() + MIN), policies)).toEqual({
      nextStatus: "confirmed",
      depositEffect: "none",
    });
    const confirmed = decide({ ...base, status: "confirmed" }, { type: "confirm_deposit", actor: "system" }, NOW, policies);
    expect(confirmed).toBeInstanceOf(FrontDeskError);
    expect((confirmed as FrontDeskError).code).toBe("invalid_request");
  });

  it("only the system confirms a paid deposit", () => {
    const waiting = { ...base, status: "awaiting_deposit" as const, payBy: new Date(NOW.getTime() + 30 * MIN) };
    for (const actor of ["agent", "owner", "customer"] as const) {
      const result = decide(waiting, { type: "confirm_deposit", actor }, NOW, policies);
      expect((result as FrontDeskError).code).toBe("invalid_request");
    }
  });
});

describe("approve a booking that needs a deposit → awaiting_deposit with a Stripe Checkout page", () => {
  it("opens a Checkout Session for the hold and waits 30 minutes; the owner isn't alerted yet", async () => {
    const { deps, stripe, notifier } = setup();
    const booking = await hold(deps);
    const token = approvalToken(booking);
    const approved = await approve(deps, booking);

    const session = stripe.onlySession();
    expect(session).toMatchObject({
      bookingId: booking.id,
      amountCents: 1000,
      description: "Deposit: Haircut at Hart's Barbers, Sat 14 Nov, 2:00 pm EST",
      returnUrl: `${TEST_BASE_URL}/approve/${token}`,
      status: "open",
    });
    expect(approved).toMatchObject({
      status: "awaiting_deposit",
      customer: { approved: true },
      deposit: { amountCents: 1000, state: "awaiting_payment", payUrl: session.url, payBy: PAY_BY },
      // The same link, so the agent can send it again: its page has the Pay button.
      approval: { url: booking.approval!.url, expiresAt: PAY_BY },
    });
    expect(notifier.alerts).toEqual([]);
    expect(await events(deps, booking.id)).toEqual([
      ["booked", "agent", expect.anything()],
      ["approved", "customer", { from: "awaiting_approval", to: "awaiting_deposit", depositEffect: "none", depositCollected: false }],
    ]);
    // The slot stays held.
    expect(await isFree(deps, SAT_1400)).toBe(false);
    expect(DEPOSIT_PAY_MINUTES).toBe(30);
  });

  it("the approval page shows awaiting_deposit with the Pay URL and when the hold expires", async () => {
    const { deps, stripe } = setup();
    const booking = await hold(deps);
    await approve(deps, booking);
    const view = await getApprovalView(deps, approvalToken(booking));
    expect(view.status).toBe("awaiting_deposit");
    expect(view.deposit).toEqual({ amountCents: 1000, state: "awaiting_payment", payUrl: stripe.onlySession().url, payBy: PAY_BY });
  });

  it("the approve form answers 303 → the Checkout URL; JSON answers the booking with deposit.payUrl; both return to the request's origin", async () => {
    const origin = "https://emergent-git-deposits.vercel.app";
    const form = setup();
    const formBooking = await hold(form.deps);
    const formToken = approvalToken(formBooking);
    const res = await approvalApprovePost(
      () => form.deps,
      new Request(`${origin}/api/approvals/${formToken}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "phone=",
      }),
      formToken,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(form.stripe.onlySession().url);
    expect(form.stripe.onlySession().returnUrl).toBe(`${origin}/approve/${formToken}`);

    const json = setup();
    const jsonBooking = await hold(json.deps);
    const jsonToken = approvalToken(jsonBooking);
    const res2 = await approvalApprovePost(
      () => json.deps,
      new Request(`${origin}/api/approvals/${jsonToken}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      jsonToken,
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as ApproveResponse;
    expect(body.booking.status).toBe("awaiting_deposit");
    expect(body.booking.deposit.payUrl).toBe(json.stripe.onlySession().url);
    expect(body.booking.approval?.url).toBe(`${origin}/approve/${jsonToken}`);
  });

  it("if Stripe fails to open the page, nothing is stored: approve fails and can be tried again", async () => {
    const { deps, stripe } = setup();
    const booking = await hold(deps);
    stripe.failNext("createCheckout", "Stripe is down");
    await expect(approve(deps, booking)).rejects.toThrow("Stripe is down");
    expect((await read(deps, booking.id)).status).toBe("awaiting_approval");
    expect((await approve(deps, booking)).status).toBe("awaiting_deposit");
  });

  it("a Beard trim (no deposit) is confirmed the moment it's approved, with no Stripe call", async () => {
    const { deps, stripe, notifier } = setup();
    const approved = await approve(deps, await hold(deps, SAT_1400, "beard-trim"));
    expect(approved).toMatchObject({ status: "confirmed", deposit: { amountCents: 0, state: "none" } });
    expect(stripe.calls).toEqual([]);
    expect(notifier.alerts).toHaveLength(1);
  });

  it("a deposit service beyond the deposit horizon (the owner shortened it) is confirmed without one: not_collected", async () => {
    const { deps, stripe } = setup();
    // book refuses beyond the horizon, so book with the default horizon (6 days), then shorten it.
    const booking = await hold(deps);
    await deps.catalog.savePolicies(SHOP, { depositHorizonDays: 2 });
    expect(await approve(deps, booking)).toMatchObject({ status: "confirmed", deposit: { state: "not_collected" } });
    expect(stripe.calls).toEqual([]);
  });
});

describe("paid → confirmed (no webhook: reads ask Stripe)", () => {
  it("get_booking after paying: confirmed, deposit held, one deposit.paid event, the owner alerted once", async () => {
    const { deps, stripe, notifier } = setup();
    const waiting = await approve(deps, await hold(deps));
    // Not paid yet: still waiting, nobody alerted.
    expect((await read(deps, waiting.id)).status).toBe("awaiting_deposit");
    const intent = stripe.pay(stripe.onlySession().id);

    const confirmed = await read(deps, waiting.id);
    expect(confirmed).toMatchObject({ status: "confirmed", deposit: { amountCents: 1000, state: "held" } });
    expect(confirmed.deposit).not.toHaveProperty("payUrl");
    expect(confirmed).not.toHaveProperty("approval");
    expect(notifier.alerts.map((a) => [a.kind, a.booking.id, a.booking.deposit.state])).toEqual([["booking_confirmed", waiting.id, "held"]]);
    expect((await events(deps, waiting.id)).at(-1)).toEqual([
      "deposit.paid",
      "system",
      {
        from: "awaiting_deposit",
        to: "confirmed",
        depositEffect: "none",
        depositCollected: true,
        checkoutSessionId: stripe.onlySession().id,
        paymentIntentId: intent,
      },
    ]);
    // Reading again changes nothing and alerts nobody.
    await read(deps, waiting.id);
    expect(notifier.alerts).toHaveLength(1);
  });

  it("the approval page (Stripe's success_url) shows You're booked: status approved, deposit held", async () => {
    const { deps, stripe } = setup();
    const booking = await hold(deps);
    await approve(deps, booking);
    stripe.pay(stripe.onlySession().id);
    const view = await getApprovalView(deps, approvalToken(booking));
    expect(view.status).toBe("approved");
    expect(view.deposit).toEqual({ amountCents: 1000, state: "held" });
  });

  it("the owner's list confirms a paid one too", async () => {
    const { deps, stripe } = setup();
    const waiting = await approve(deps, await hold(deps));
    stripe.pay(stripe.onlySession().id);
    const { bookings } = (await listShopBookings(deps, SHOP)) satisfies BookingsResponse;
    expect(bookings.find((b) => b.id === waiting.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });
  });

  it("paid after pay_by but before anyone looked: confirmed, not expired (Stripe took the hold)", async () => {
    const { deps, stripe, clock } = setup();
    const waiting = await approve(deps, await hold(deps));
    clock.advance(31 * MIN);
    stripe.pay(stripe.onlySession().id);
    expect(await read(deps, waiting.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });
  });

  it("if Stripe doesn't answer, the booking keeps waiting and the next read asks again", async () => {
    const { deps, stripe } = setup();
    const waiting = await approve(deps, await hold(deps));
    stripe.pay(stripe.onlySession().id);
    stripe.failNext("getCheckout");
    expect((await read(deps, waiting.id)).status).toBe("awaiting_deposit");
    expect((await read(deps, waiting.id)).status).toBe("confirmed");
  });
});

describe("unpaid past pay_by → expired, the page closed, the time free again", () => {
  it("get_booking at pay_by: expired (actor system, released), the Checkout Session expired, the slot bookable", async () => {
    const { deps, stripe, clock, notifier } = setup();
    const waiting = await approve(deps, await hold(deps));
    clock.advance(29 * MIN);
    expect((await read(deps, waiting.id)).status).toBe("awaiting_deposit");
    expect(await isFree(deps, SAT_1400)).toBe(false);

    clock.advance(1 * MIN);
    const expired = await read(deps, waiting.id);
    expect(expired).toMatchObject({ status: "expired", deposit: { state: "released" } });
    expect(expired).not.toHaveProperty("approval");
    expect(stripe.onlySession().status).toBe("expired");
    expect(await events(deps, waiting.id)).toEqual([
      ["booked", "agent", expect.anything()],
      ["approved", "customer", expect.anything()],
      ["expired", "system", { from: "awaiting_deposit", to: "expired", depositEffect: "released", depositCollected: false }],
    ]);
    expect(notifier.alerts).toEqual([]);
    expect(await isFree(deps, SAT_1400)).toBe(true);
    expect((await getApprovalView(deps, approvalToken(waiting))).status).toBe("expired");
  });

  it("get_availability offers the time again at pay_by even before anyone reads it, and book takes it", async () => {
    const { deps, stripe, clock } = setup();
    const waiting = await approve(deps, await hold(deps));
    clock.advance(30 * MIN);
    expect(await isFree(deps, SAT_1400)).toBe(true);
    // book asks Stripe about the lapsed booking in its way, expires it, then holds the time.
    const again = await hold(deps);
    expect(again.status).toBe("awaiting_approval");
    expect(stripe.sessions.get(stripe.onlySession().id)?.status).toBe("expired");
    expect((await deps.store.getBooking(waiting.id))?.status).toBe("expired");
  });

  it("book doesn't take the time from a booking that was paid after pay_by: it's confirmed, so slot_taken", async () => {
    const { deps, stripe, clock } = setup();
    await approve(deps, await hold(deps));
    clock.advance(31 * MIN);
    stripe.pay(stripe.onlySession().id);
    await expect(hold(deps)).rejects.toMatchObject({ code: "slot_taken" });
  });
});

describe("the money moves on each transition, after the change is stored", () => {
  it("no-show: the hold is captured", async () => {
    const { deps, stripe, clock } = setup();
    const confirmed = await paidBooking(deps, stripe, TUE_1000);
    clock.set("2026-11-10T10:30:00-05:00");
    const result = await ownerBookingAction(deps, SHOP, confirmed.id, "mark_no_show");
    expect(result).toMatchObject({ depositEffect: "captured", depositCollected: true, booking: { status: "no_show", deposit: { state: "captured" } } });
    const intent = stripe.onlySession().paymentIntentId!;
    expect(stripe.intents.get(intent)).toBe("succeeded");
    expect(stripe.calls.at(-1)).toBe(`capture ${intent}`);
  });

  it("complete: the hold is released", async () => {
    const { deps, stripe, clock } = setup();
    const confirmed = await paidBooking(deps, stripe, TUE_1000);
    clock.set("2026-11-10T10:30:00-05:00");
    const result = await ownerBookingAction(deps, SHOP, confirmed.id, "complete");
    expect(result).toMatchObject({ depositEffect: "released", depositCollected: true, booking: { status: "completed", deposit: { state: "released" } } });
    expect(stripe.intents.get(stripe.onlySession().paymentIntentId!)).toBe("canceled");
  });

  it("an agent cancelling inside the cancellation window: captured", async () => {
    const { deps, stripe } = setup();
    const confirmed = await paidBooking(deps, stripe, TUE_1000);
    const result = await cancelBooking(deps, SHOP, { booking_id: confirmed.id });
    expect(result).toMatchObject({ depositEffect: "captured", depositCollected: true, booking: { status: "cancelled", deposit: { state: "captured" } } });
    expect(stripe.intents.get(stripe.onlySession().paymentIntentId!)).toBe("succeeded");
  });

  it("an agent cancelling in time: released", async () => {
    const { deps, stripe } = setup();
    const confirmed = await paidBooking(deps, stripe, SAT_1400);
    const result = await cancelBooking(deps, SHOP, { booking_id: confirmed.id });
    expect(result).toMatchObject({ depositEffect: "released", depositCollected: true, booking: { deposit: { state: "released" } } });
    expect(stripe.intents.get(stripe.onlySession().paymentIntentId!)).toBe("canceled");
  });

  it("the owner cancelling (even inside the window): released", async () => {
    const { deps, stripe } = setup();
    const confirmed = await paidBooking(deps, stripe, TUE_1000);
    const result = await ownerBookingAction(deps, SHOP, confirmed.id, "cancel");
    expect(result).toMatchObject({ depositEffect: "released", booking: { deposit: { state: "released" } } });
    expect(stripe.intents.get(stripe.onlySession().paymentIntentId!)).toBe("canceled");
  });

  it("cancelling a booking still awaiting its deposit closes the payment page and frees the time", async () => {
    const { deps, stripe } = setup();
    const waiting = await approve(deps, await hold(deps));
    const result = await cancelBooking(deps, SHOP, { booking_id: waiting.id });
    expect(result).toMatchObject({ depositEffect: "released", depositCollected: false, booking: { status: "cancelled", deposit: { state: "released" } } });
    expect(stripe.onlySession().status).toBe("expired");
    expect(await isFree(deps, SAT_1400)).toBe(true);
  });

  it("declining a hold moves nothing in Stripe (nothing was asked for)", async () => {
    const { deps, stripe } = setup();
    const booking = await hold(deps);
    const { booking: declined } = await declineBooking(deps, approvalToken(booking));
    expect(declined).toMatchObject({ status: "cancelled", deposit: { state: "none" } });
    expect(stripe.calls).toEqual([]);
  });
});

describe("a Stripe failure never undoes the booking change", () => {
  it("a failed capture: the no-show stands, the deposit stays held, one deposit.action_failed event, the owner's list shows it", async () => {
    const { deps, stripe, clock } = setup();
    const confirmed = await paidBooking(deps, stripe, TUE_1000);
    clock.set("2026-11-10T10:30:00-05:00");
    stripe.failNext("capture", "Your card was declined.");
    const result = await ownerBookingAction(deps, SHOP, confirmed.id, "mark_no_show");
    const failure = { action: "capture", message: "Your card was declined.", at: "2026-11-10T10:30:00-05:00" };
    expect(result).toMatchObject({
      depositEffect: "captured",
      depositCollected: true,
      booking: { status: "no_show", deposit: { state: "held", actionFailed: failure } },
    });
    expect((await events(deps, confirmed.id)).at(-1)).toEqual([
      "deposit.action_failed",
      "system",
      { action: "capture", message: "Your card was declined.", paymentIntentId: stripe.onlySession().paymentIntentId, checkoutSessionId: stripe.onlySession().id },
    ]);
    const { bookings } = await listShopBookings(deps, SHOP);
    expect(bookings.find((b) => b.id === confirmed.id)?.deposit.actionFailed).toEqual(failure);
  });

  it("a failed release on expiry: the booking still expires and the time is free", async () => {
    const { deps, stripe, clock } = setup();
    const waiting = await approve(deps, await hold(deps));
    clock.advance(30 * MIN);
    stripe.failNext("expireCheckout", "Stripe is down");
    const expired = await read(deps, waiting.id);
    expect(expired).toMatchObject({
      status: "expired",
      deposit: { state: "awaiting_payment", actionFailed: { action: "release", message: "Stripe is down" } },
    });
    expect(await isFree(deps, SAT_1400)).toBe(true);
  });
});

describe("deposits off (no STRIPE_SECRET_KEY): everything still books", () => {
  it("deps have no payments without a key, and Stripe with one", () => {
    expect(createFrontDeskDeps({}, () => {}).payments).toBeNull();
    expect(createFrontDeskDeps({ STRIPE_SECRET_KEY: "  " }, () => {}).payments).toBeNull();
    expect(paymentsFrom({ STRIPE_SECRET_KEY: "sk_test_123" })).not.toBeNull();
  });

  it("/api/status says deposits off or stripe_test, and off is not a problem", async () => {
    const memory = { memoryShopName: async () => "Hart's Barbers", memoryLastNightlyRun: async () => null };
    const off = await getStatus({ OWNER_API_TOKEN: "t" }, TEST_BASE_URL, memory);
    expect(off).toMatchObject({ status: "ready", deposits: "off", problems: [] });
    const on = await getStatus({ OWNER_API_TOKEN: "t", STRIPE_SECRET_KEY: "sk_test_123" }, TEST_BASE_URL, memory);
    expect(on).toMatchObject({ status: "ready", deposits: "stripe_test" });
    expect(JSON.stringify(on)).not.toContain("sk_test_123");
  });

  it("approving a Haircut confirms it at once, deposit not_collected; a no-show moves no money", async () => {
    const { deps, notifier, clock } = setup({ payments: null });
    const approved = await approve(deps, await hold(deps, TUE_1000));
    expect(approved).toMatchObject({ status: "confirmed", deposit: { amountCents: 1000, state: "not_collected" } });
    expect(notifier.alerts).toHaveLength(1);
    clock.set("2026-11-10T10:30:00-05:00");
    const result = await ownerBookingAction(deps, SHOP, approved.id, "mark_no_show");
    expect(result).toMatchObject({ depositEffect: "captured", depositCollected: false, booking: { deposit: { state: "not_collected" } } });
    expect(result.booking.deposit).not.toHaveProperty("actionFailed");
  });
});

describe("what agents read", () => {
  let nextId = 1;
  async function callTool(deps: FrontDeskDeps, name: string, args: Record<string, unknown>) {
    const res = await createFrontDeskMcpHandler(() => deps)(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    const body = await res.text();
    const json = body.trimStart().startsWith("{")
      ? body
      : body
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
    return (JSON.parse(json) as { result: { content: { text: string }[]; structuredContent?: unknown; isError?: boolean } }).result;
  }

  it("book says the deposit is paid after approving; get_booking on awaiting_deposit says to send the same approval link", async () => {
    const { deps } = setup();
    const booked = await callTool(deps, "book", { service_id: "haircut", start: SAT_1400, customer_name: "Maya" });
    expect(booked.isError).toBeFalsy();
    expect(booked.content[0].text).toContain("After approving, Maya pays a $10 deposit hold on the same page");
    const { booking } = booked.structuredContent as { booking: Booking };

    await approve(deps, booking);
    const got = await callTool(deps, "get_booking", { booking_id: booking.id });
    expect(got.isError).toBeFalsy();
    const text = got.content[0].text;
    expect(text).toContain("Status: awaiting_deposit.");
    expect(text).toContain("Maya approved it, but it isn't confirmed until they pay the $10 deposit hold by Mon 9 Nov, 12:30 pm UTC-5.");
    expect(text).toContain(`Send them the same approval link again if needed (its page has the Pay button): ${booking.approval!.url}`);
    expect(text).toContain("Deposit: $10 (waiting for payment).");
    expect((got.structuredContent as GetBookingResult).booking.deposit.state).toBe("awaiting_payment");
  });

  it("cancel says the held deposit was charged or released", async () => {
    const { deps, stripe } = setup();
    const confirmed = await paidBooking(deps, stripe, SAT_1400);
    const cancelled = await callTool(deps, "cancel", { booking_id: confirmed.id });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.content[0].text).toContain("the $10 deposit is released: the customer keeps it. The hold on the card was released.");
    expect(cancelled.structuredContent).toMatchObject({ depositEffect: "released", depositCollected: true });
  });
});
