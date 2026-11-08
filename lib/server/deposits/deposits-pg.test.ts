import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking } from "../consent/approvals";
import { ownerBookingAction } from "../frontdesk/owner";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "../frontdesk/postgres-store";
import { book, getAvailability, getBooking, listShopBookings } from "../frontdesk/service";
import { approvalToken, recordingNotifier, withBaseUrl } from "../frontdesk/test-support";
import { stubPayments } from "./stub-payments";

// Deposits against a real Postgres (0005's columns), through the same use cases as deposits.test.ts with a
// stubbed Stripe, when DATABASE_URL_TEST points at a database with every migration and the seed applied
// (see docs/database.md). Like consent-pg.test.ts it never touches Hart's: a throwaway shop (one staff
// member, Tue–Sat 09:00–17:00, a 30-minute service with a $5 deposit), bookings only in 2099, each test in
// its own week, and everything deleted in afterAll.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Deposits on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run deposits against a real database", () => {});
  });
} else {
  describe("Deposits on Postgres (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const sql = getPostgresClient(url);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-deposits-${run}`;
    const staffId = `vitest-deposits-${run}-sam`;
    const zone = "America/New_York";

    let now = new Date();
    const clock: Clock = { now: () => new Date(now.getTime()) };
    const notifier = recordingNotifier();
    const stripe = stubPayments();
    const deps = withBaseUrl({ catalog: store, store, clock, notifier, payments: stripe });

    // A random Tuesday in 2099; each test books in its own week after it.
    const firstTuesday = DateTime.fromObject({ year: 2099, month: 1, day: 6 }, { zone })
      .plus({ weeks: Math.floor(Math.random() * 30) })
      .set({ weekday: 2 })
      .startOf("day");
    const time = (week: number, dayOffset: number, hh: number, mm = 0) =>
      firstTuesday.plus({ weeks: week, days: dayOffset }).set({ hour: hh, minute: mm }).toISO({ suppressMilliseconds: true })!;
    const setNow = (iso: string) => {
      now = new Date(iso);
    };

    const hold = async (start: string): Promise<Booking> =>
      (await book(deps, shop, { service_id: "trim", start, customer_name: "Deposit Test" }, "vitest deposits")).booking;
    const approve = async (booking: Booking) => (await approveBooking(deps, approvalToken(booking), {})).booking;
    const read = async (id: string) => (await getBooking(deps, shop, { booking_id: id })).booking;
    const columns = async (id: string) =>
      (
        await sql<
          {
            deposit_state: string;
            checkout_session_id: string | null;
            checkout_url: string | null;
            payment_intent_id: string | null;
            pay_by: Date | null;
            deposit_failure: unknown;
          }[]
        >`select deposit_state, checkout_session_id, checkout_url, payment_intent_id, pay_by, deposit_failure from bookings where id = ${id}::uuid`
      )[0];
    const sessionOf = async (id: string) => {
      const sessionId = (await columns(id)).checkout_session_id;
      const session = sessionId ? stripe.sessions.get(sessionId) : undefined;
      if (!session) throw new Error(`Booking ${id} has no checkout session.`);
      return session;
    };

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Deposit Shop', ${zone})`;
      await sql`insert into staff (id, shop_slug, name) values (${staffId}, ${shop}, 'Sam')`;
      await sql`
        insert into weekly_hours (staff_id, weekday, opens, closes)
        select ${staffId}, day, time '09:00', time '17:00' from generate_series(2, 6) as day
      `;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 500, 1)
      `;
      await sql`
        insert into policies (shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours)
        values (${shop}, 120, 30, 6, 24)
      `;
    });

    afterAll(async () => {
      await sql`delete from bookings where shop_slug = ${shop}`; // events and approvals cascade
      await sql`delete from shops where slug = ${shop}`; // staff, hours, services and policies cascade
      await closePostgresClients();
    });

    it("approve stores the Checkout Session, its URL and pay_by; paying confirms it (held); a no-show captures it", async () => {
      setNow(time(0, 0, 9));
      const booking = await hold(time(0, 1, 10));
      const waiting = await approve(booking);
      const session = await sessionOf(booking.id);
      expect(waiting).toMatchObject({
        status: "awaiting_deposit",
        deposit: { amountCents: 500, state: "awaiting_payment", payUrl: session.url, payBy: time(0, 0, 9, 30) },
      });
      expect(await columns(booking.id)).toMatchObject({
        deposit_state: "awaiting_payment",
        checkout_url: session.url,
        payment_intent_id: null,
        pay_by: new Date(time(0, 0, 9, 30)),
      });

      const intent = stripe.pay(session.id);
      expect(await read(booking.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });
      expect((await columns(booking.id)).payment_intent_id).toBe(intent);
      expect((await store.listEvents(booking.id)).map((e) => e.type)).toEqual(["booked", "approved", "deposit.paid"]);

      setNow(time(0, 1, 10, 30));
      const result = await ownerBookingAction(deps, shop, booking.id, "mark_no_show");
      expect(result.booking).toMatchObject({ status: "no_show", deposit: { state: "captured" } });
      expect(stripe.intents.get(intent)).toBe("succeeded");
    });

    it("a failed release is stored as deposit_failure and a deposit.action_failed event, and shows in the owner's list", async () => {
      setNow(time(1, 0, 9));
      const booking = await hold(time(1, 1, 10));
      await approve(booking);
      const session = await sessionOf(booking.id);
      stripe.pay(session.id);
      await read(booking.id);

      setNow(time(1, 1, 10, 30));
      stripe.failNext("cancel", "Stripe is down");
      const result = await ownerBookingAction(deps, shop, booking.id, "complete");
      const failure = { action: "release", message: "Stripe is down", at: time(1, 1, 10, 30) };
      expect(result.booking).toMatchObject({ status: "completed", deposit: { state: "held", actionFailed: failure } });
      const events = await store.listEvents(booking.id);
      expect(events.at(-1)).toMatchObject({ type: "deposit.action_failed", actor: "system", data: { action: "release", message: "Stripe is down" } });
      const { bookings } = await listShopBookings({ ...deps, clock: { now: () => new Date(time(1, 0, 9)) } }, shop);
      expect(bookings.find((b) => b.id === booking.id)?.deposit.actionFailed).toEqual(failure);
    });

    it("unpaid past pay_by: expired, its page closed, and the time free again", async () => {
      setNow(time(2, 0, 9));
      const start = time(2, 1, 10);
      const booking = await hold(start);
      await approve(booking);
      const session = await sessionOf(booking.id);

      setNow(time(2, 0, 9, 30));
      const free = await getAvailability(deps, shop, { service_id: "trim", from: start, to: time(2, 1, 11) });
      expect(free.slots.some((s) => s.start === start)).toBe(true);
      expect(await read(booking.id)).toMatchObject({ status: "expired", deposit: { state: "released" } });
      expect(session.status).toBe("expired");
      expect((await hold(start)).status).toBe("awaiting_approval");
    });
  });
}
