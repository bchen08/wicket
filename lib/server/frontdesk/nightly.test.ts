import { describe, expect, it } from "vitest";
import type { Booking, NightlyRunResponse } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking } from "../consent/approvals";
import { stubPayments, type StubPayments } from "../deposits/stub-payments";
import { getFrontDeskDeps } from "./deps";
import { COMPLETE_AFTER_HOURS, nightlyGet, runNightly } from "./nightly";
import { ownerBookingAction } from "./owner";
import { book, getBooking, type FrontDeskDeps } from "./service";
import { getStatus } from "./status";
import { alertSummary, approvalToken, memoryDeps, NOW, recordingNotifier } from "./test-support";

// The nightly tidy-up (nightly.ts) on the in-memory store with a stubbed Stripe. NOW is Mon 9 Nov 2026, noon
// in New York. Bookings are made the way an agent and the person make them (book, approve, pay), then the
// clock moves to the night after, when Vercel Cron would call GET /api/jobs/nightly (03:00 New York).

const SHOP = "harts";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Tue 10 Nov: Haircuts (30 minutes) the person pays the $10 hold for. */
const TUE_1000 = "2026-11-10T10:00:00-05:00";
const TUE_1100 = "2026-11-10T11:00:00-05:00";
const TUE_1500 = "2026-11-10T15:00:00-05:00";
const TUE_1600 = "2026-11-10T16:00:00-05:00";
/** Sat 14 Nov: still ahead when the job runs. */
const SAT_1400 = "2026-11-14T14:00:00-05:00";
/** Wed 11 Nov, 03:00 New York = 08:00 UTC: when the cron runs after Tuesday's appointments. */
const WED_0300 = "2026-11-11T03:00:00-05:00";

function movableClock(start: Date = NOW): Clock & { set(iso: string): void; advance(ms: number): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (iso) => (t = new Date(iso).getTime()),
    advance: (ms) => (t += ms),
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

async function hold(deps: FrontDeskDeps, start: string, service = "haircut"): Promise<Booking> {
  return (await book(deps, SHOP, { service_id: service, start, customer_name: "Maya Lopez" }, "Claude")).booking;
}

async function approve(deps: FrontDeskDeps, booking: Booking): Promise<Booking> {
  return (await approveBooking(deps, approvalToken(booking), {})).booking;
}

async function read(deps: FrontDeskDeps, id: string): Promise<Booking> {
  return (await getBooking(deps, SHOP, { booking_id: id })).booking;
}

/** The Checkout Session opened for `bookingId`. */
function sessionOf(stripe: StubPayments, bookingId: string) {
  const session = [...stripe.sessions.values()].find((s) => s.bookingId === bookingId);
  if (!session) throw new Error(`No checkout session for ${bookingId}`);
  return session;
}

/** The person pays the hold for `booking` (awaiting its deposit). Returns the PaymentIntent's id. Nobody reads it yet. */
function pay(stripe: StubPayments, booking: Booking): string {
  return stripe.pay(sessionOf(stripe, booking.id).id);
}

/** A Haircut the person approved and paid for, read back: confirmed, deposit held. */
async function paidBooking(deps: FrontDeskDeps, stripe: StubPayments, start: string): Promise<{ booking: Booking; intent: string }> {
  const waiting = await approve(deps, await hold(deps, start));
  const intent = pay(stripe, waiting);
  return { booking: await read(deps, waiting.id), intent };
}

async function events(deps: FrontDeskDeps, id: string) {
  return (await deps.store.listEvents(id)).map((e) => [e.type, e.actor, e.data]);
}

const counts = (run: NightlyRunResponse) => ({
  expired: run.expired,
  completed: run.completed,
  depositsReleased: run.depositsReleased,
  failures: run.failures,
});

describe("the nightly tidy-up: past confirmed bookings → completed, deposit released", () => {
  it("completes a confirmed booking that ended more than 3 hours ago and releases its $10 hold, with actor system", async () => {
    const { deps, clock, stripe } = setup();
    const { booking, intent } = await paidBooking(deps, stripe, TUE_1000);
    expect(booking).toMatchObject({ status: "confirmed", deposit: { state: "held" } });

    clock.set(WED_0300);
    const run = await runNightly(deps);

    expect(counts(run)).toEqual({ expired: 0, completed: 1, depositsReleased: 1, failures: 0 });
    const after = await read(deps, booking.id);
    expect(after).toMatchObject({ status: "completed", deposit: { state: "released" } });
    expect(after.deposit.actionFailed).toBeUndefined();
    // In Stripe: the PaymentIntent holding the deposit is cancelled (the person keeps their money).
    expect(stripe.intents.get(intent)).toBe("canceled");
    expect((await events(deps, booking.id)).at(-1)).toEqual([
      "completed",
      "system",
      { from: "confirmed", to: "completed", depositEffect: "released", depositCollected: true },
    ]);
  });

  it(`leaves future bookings and ones that ended ${COMPLETE_AFTER_HOURS} hours ago or less alone`, async () => {
    const { deps, clock, stripe } = setup();
    const ended = await paidBooking(deps, stripe, TUE_1000); // ends 10:30
    const justEnded = await paidBooking(deps, stripe, TUE_1100); // ends 11:30
    const future = await paidBooking(deps, stripe, SAT_1400);

    // 11:30 + 3 hours exactly: the 11:00 isn't "more than 3 hours ago" yet; the 10:00 is.
    clock.set("2026-11-10T14:30:00-05:00");
    const run = await runNightly(deps);

    expect(counts(run)).toEqual({ expired: 0, completed: 1, depositsReleased: 1, failures: 0 });
    expect((await read(deps, ended.booking.id)).status).toBe("completed");
    expect(await read(deps, justEnded.booking.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });
    expect(await read(deps, future.booking.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });
    expect(stripe.intents.get(justEnded.intent)).toBe("requires_capture");
    expect(stripe.intents.get(future.intent)).toBe("requires_capture");
  });

  it("completes a booking without a deposit too, without counting a release or calling Stripe", async () => {
    const { deps, clock, stripe } = setup();
    const trim = await approve(deps, await hold(deps, TUE_1000, "beard-trim"));
    expect(trim).toMatchObject({ status: "confirmed", deposit: { state: "none" } });
    const callsBefore = stripe.calls.length;

    clock.set(WED_0300);
    const run = await runNightly(deps);

    expect(counts(run)).toEqual({ expired: 0, completed: 1, depositsReleased: 0, failures: 0 });
    expect((await read(deps, trim.id)).status).toBe("completed");
    expect(stripe.calls.slice(callsBefore)).toEqual([]);
  });

  it("with deposits off, completes a booking whose deposit was never collected, moving no money", async () => {
    const { deps, clock } = setup({ payments: null });
    const confirmed = await approve(deps, await hold(deps, TUE_1000));
    expect(confirmed.deposit.state).toBe("not_collected");

    clock.set(WED_0300);
    expect(counts(await runNightly(deps))).toEqual({ expired: 0, completed: 1, depositsReleased: 0, failures: 0 });
    expect(await read(deps, confirmed.id)).toMatchObject({ status: "completed", deposit: { state: "not_collected" } });
  });

  it("skips a booking the owner marked in the meantime (a no-show stays a no-show, its capture untouched)", async () => {
    const { deps, clock, stripe } = setup();
    const { booking, intent } = await paidBooking(deps, stripe, TUE_1000);
    clock.set(WED_0300);
    // The job read its list just before the owner marked the no-show: hand it the stale list.
    const stale = await deps.store.listBookings(SHOP, { start: new Date("2026-11-10T00:00:00-05:00"), end: new Date(WED_0300) });
    await ownerBookingAction(deps, SHOP, booking.id, "mark_no_show");
    const racing: FrontDeskDeps = {
      ...deps,
      store: { ...deps.store, listBookings: async (_shop, _range, statuses) => stale.filter((b) => !statuses || statuses.includes(b.status)) },
    };

    expect(counts(await runNightly(racing))).toEqual({ expired: 0, completed: 0, depositsReleased: 0, failures: 0 });
    expect(await read(deps, booking.id)).toMatchObject({ status: "no_show", deposit: { state: "captured" } });
    expect(stripe.intents.get(intent)).toBe("succeeded");
  });
});

describe("the nightly tidy-up: holds and unpaid deposits past their deadline → expired", () => {
  it("expires holds past approve_by and unpaid deposits past pay_by (the Checkout page closed); leaves live ones alone", async () => {
    const { deps, clock, stripe, notifier } = setup();
    const lapsedHold = await hold(deps, TUE_1000, "beard-trim"); // approve_by 12:10
    const unpaid = await approve(deps, await hold(deps, TUE_1100)); // pay_by 12:30
    const paidLate = await approve(deps, await hold(deps, TUE_1500)); // pay_by 12:30, paid, never read
    pay(stripe, paidLate);
    clock.set("2026-11-09T12:25:00-05:00");
    // On Thursday, so booking it doesn't lazily expire Tuesday's (book only expires within a day of its start).
    const liveHold = await hold(deps, "2026-11-12T10:00:00-05:00", "beard-trim"); // approve_by 12:35

    clock.set("2026-11-09T12:31:00-05:00");
    const run = await runNightly(deps);

    expect(counts(run)).toEqual({ expired: 2, completed: 0, depositsReleased: 1, failures: 0 });
    expect((await deps.store.getBooking(lapsedHold.id))?.status).toBe("expired");
    expect(await deps.store.getBooking(unpaid.id)).toMatchObject({ status: "expired", deposit: { state: "released" } });
    expect(sessionOf(stripe, unpaid.id).status).toBe("expired");
    // Paid at the last moment: Stripe holds the money, so the time is theirs (as on any read), and the owner hears.
    expect(await deps.store.getBooking(paidLate.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });
    expect(alertSummary(notifier)).toContainEqual(["booking_confirmed", paidLate.id, "confirmed"]);
    expect((await deps.store.getBooking(liveHold.id))?.status).toBe("awaiting_approval");
    expect((await events(deps, lapsedHold.id)).at(-1)?.slice(0, 2)).toEqual(["expired", "system"]);
    expect((await events(deps, unpaid.id)).at(-1)?.slice(0, 2)).toEqual(["expired", "system"]);
  });

  it("expires lapsed holds and unpaid deposits anywhere in time, not only near today", async () => {
    const { deps, clock } = setup({ payments: null });
    const far = await hold(deps, "2026-12-08T10:00:00-05:00", "beard-trim"); // 29 days ahead, inside the 30-day horizon
    clock.advance(11 * MIN);
    expect(counts(await runNightly(deps))).toMatchObject({ expired: 1 });
    expect((await deps.store.getBooking(far.id))?.status).toBe("expired");
  });
});

describe("the nightly tidy-up: safe to run twice", () => {
  it("a second run changes nothing more: no new events, no Stripe calls, all counts 0", async () => {
    const { deps, clock, stripe } = setup();
    const { booking } = await paidBooking(deps, stripe, TUE_1000);
    const unpaid = await approve(deps, await hold(deps, TUE_1500));
    await hold(deps, TUE_1600, "beard-trim");

    clock.set(WED_0300);
    const first = await runNightly(deps);
    expect(counts(first)).toEqual({ expired: 2, completed: 1, depositsReleased: 2, failures: 0 });
    const eventsAfterFirst = [await events(deps, booking.id), await events(deps, unpaid.id)];
    const callsAfterFirst = [...stripe.calls];

    clock.advance(5 * MIN);
    const second = await runNightly(deps);

    expect(counts(second)).toEqual({ expired: 0, completed: 0, depositsReleased: 0, failures: 0 });
    expect([await events(deps, booking.id), await events(deps, unpaid.id)]).toEqual(eventsAfterFirst);
    expect(stripe.calls).toEqual(callsAfterFirst);
  });
});

describe("the nightly tidy-up: a Stripe failure is counted and the rest still runs", () => {
  it("a refused release is recorded as deposit.action_failed, the booking still completes, and the next booking is released", async () => {
    const { deps, clock, stripe } = setup();
    const first = await paidBooking(deps, stripe, TUE_1000);
    const second = await paidBooking(deps, stripe, TUE_1100);

    clock.set(WED_0300);
    stripe.failNext("cancel", "Stripe test failure: the PaymentIntent couldn't be cancelled.");
    const run = await runNightly(deps);

    expect(counts(run)).toEqual({ expired: 0, completed: 2, depositsReleased: 1, failures: 1 });
    const failed = await read(deps, first.booking.id);
    expect(failed).toMatchObject({
      status: "completed",
      deposit: { state: "held", actionFailed: { action: "release", message: "Stripe test failure: the PaymentIntent couldn't be cancelled." } },
    });
    expect((await events(deps, first.booking.id)).at(-1)).toEqual([
      "deposit.action_failed",
      "system",
      { action: "release", message: "Stripe test failure: the PaymentIntent couldn't be cancelled.", paymentIntentId: first.intent, checkoutSessionId: sessionOf(stripe, first.booking.id).id },
    ]);
    expect(stripe.intents.get(first.intent)).toBe("requires_capture");
    expect(await read(deps, second.booking.id)).toMatchObject({ status: "completed", deposit: { state: "released" } });
    expect(stripe.intents.get(second.intent)).toBe("canceled");

    // Running it again doesn't retry the refused release (TODO(ring-2)) and changes nothing more.
    expect(counts(await runNightly(deps))).toEqual({ expired: 0, completed: 0, depositsReleased: 0, failures: 0 });
  });

  it("Stripe not answering about an unpaid deposit leaves it waiting (counted), and the other bookings still run", async () => {
    const { deps, clock, stripe } = setup();
    const unpaid = await approve(deps, await hold(deps, TUE_1500)); // pay_by 12:30
    const done = await paidBooking(deps, stripe, TUE_1000);

    clock.set(WED_0300);
    stripe.failNext("getCheckout", "Stripe test failure: no answer.");
    const run = await runNightly(deps);

    expect(counts(run)).toEqual({ expired: 0, completed: 1, depositsReleased: 1, failures: 1 });
    expect((await deps.store.getBooking(unpaid.id))?.status).toBe("awaiting_deposit");
    expect((await deps.store.getBooking(done.booking.id))?.status).toBe("completed");

    // The next run asks again and expires it.
    expect(counts(await runNightly(deps))).toEqual({ expired: 1, completed: 0, depositsReleased: 1, failures: 0 });
    expect(await deps.store.getBooking(unpaid.id)).toMatchObject({ status: "expired", deposit: { state: "released" } });
  });

  it("closing an unpaid Checkout page that Stripe refuses is a failure; the booking still expires", async () => {
    const { deps, clock, stripe } = setup();
    const unpaid = await approve(deps, await hold(deps, TUE_1500));
    clock.set(WED_0300);
    stripe.failNext("expireCheckout");

    expect(counts(await runNightly(deps))).toEqual({ expired: 1, completed: 0, depositsReleased: 0, failures: 1 });
    expect(await deps.store.getBooking(unpaid.id)).toMatchObject({
      status: "expired",
      deposit: { state: "awaiting_payment", actionFailed: { action: "release" } },
    });
  });

  it("an error on one booking is counted and the next one still runs", async () => {
    const { deps, clock, stripe } = setup();
    const broken = await paidBooking(deps, stripe, TUE_1000);
    const fine = await paidBooking(deps, stripe, TUE_1100);
    clock.set(WED_0300);
    const flaky: FrontDeskDeps = {
      ...deps,
      store: {
        ...deps.store,
        refreshBooking: async (id, now) => {
          if (id === broken.booking.id) throw new Error("connection reset");
          return deps.store.refreshBooking(id, now);
        },
      },
    };

    expect(counts(await runNightly(flaky))).toEqual({ expired: 0, completed: 1, depositsReleased: 1, failures: 1 });
    expect((await deps.store.getBooking(broken.booking.id))?.status).toBe("confirmed");
    expect((await deps.store.getBooking(fine.booking.id))?.status).toBe("completed");
  });
});

describe("GET /api/jobs/nightly and /api/status", () => {
  it("answers 200 with the counts and when it ran, never cached, and /api/status shows it as lastNightlyRun", async () => {
    const { deps, clock, stripe } = setup();
    await paidBooking(deps, stripe, TUE_1000);
    clock.set(WED_0300);

    const res = await nightlyGet(new Request("https://emergent.vercel.app/api/jobs/nightly"), () => deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as NightlyRunResponse;
    expect(body).toEqual({ ranAt: "2026-11-11T08:00:00Z", expired: 0, completed: 1, depositsReleased: 1, failures: 0 });
    expect(await deps.store.lastNightlyRun()).toEqual(body);

    const status = await getStatus({ OWNER_API_TOKEN: "t" }, "http://localhost:3000", {
      memoryShopName: async () => "Hart's Barbers",
      memoryLastNightlyRun: () => deps.store.lastNightlyRun(),
    });
    expect(status.lastNightlyRun).toEqual(body);
  });

  it("records every run, even one with nothing to do; the newest is the last run", async () => {
    const { deps, clock } = setup();
    clock.set(WED_0300);
    await runNightly(deps);
    clock.advance(24 * HOUR);
    const newest = await runNightly(deps);
    expect(newest).toEqual({ ranAt: "2026-11-12T08:00:00Z", expired: 0, completed: 0, depositsReleased: 0, failures: 0 });
    expect(await deps.store.lastNightlyRun()).toEqual(newest);
  });

  it("answers the ApiError envelope (500 internal) when the run can't be recorded", async () => {
    const { deps } = setup();
    const broken: FrontDeskDeps = {
      ...deps,
      store: {
        ...deps.store,
        recordNightlyRun: async () => {
          throw new Error("database is down");
        },
      },
    };
    const res = await nightlyGet(new Request("https://emergent.vercel.app/api/jobs/nightly"), () => broken);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal");
  });

  it("the in-memory deployment (pnpm dev) can be tidied too", async () => {
    // getFrontDeskDeps without DATABASE_URL: the shared in-memory store, with nothing past its time.
    const res = await nightlyGet(new Request("http://localhost:3000/api/jobs/nightly"), getFrontDeskDeps);
    expect(res.status).toBe(200);
    expect(counts((await res.json()) as NightlyRunResponse)).toEqual({ expired: 0, completed: 0, depositsReleased: 0, failures: 0 });
  });
});
