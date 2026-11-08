import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking } from "../consent/approvals";
import { stubPayments } from "../deposits/stub-payments";
import { ALL_TIME } from "./booking-store";
import { tidyShop } from "./nightly";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book, getBooking } from "./service";
import { approvalToken, recordingNotifier, withBaseUrl } from "./test-support";

// The nightly tidy-up against a real Postgres (0006's nightly_runs, and the status filter on listBookings),
// through the same use cases as nightly.test.ts with a stubbed Stripe, when DATABASE_URL_TEST points at a
// database with every migration and the seed applied (see docs/database.md). Like deposits-pg.test.ts it
// never touches Hart's: it tidies only a throwaway shop (tidyShop, not runNightly, which would go through
// every shop in the database), with bookings only in 2099, and deletes everything in afterAll.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Nightly tidy-up on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the nightly tidy-up against a real database", () => {});
  });
} else {
  describe("Nightly tidy-up on Postgres (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const sql = getPostgresClient(url);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-nightly-${run}`;
    const staffId = `vitest-nightly-${run}-sam`;
    const zone = "America/New_York";

    let now = new Date();
    const clock: Clock = { now: () => new Date(now.getTime()) };
    const stripe = stubPayments();
    const deps = withBaseUrl({ catalog: store, store, clock, notifier: recordingNotifier(), payments: stripe });
    /** nightly_runs rows this file wrote, deleted in afterAll. */
    const runIds: string[] = [];

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
      (await book(deps, shop, { service_id: "trim", start, customer_name: "Nightly Test" }, "vitest nightly")).booking;
    const approve = async (booking: Booking) => (await approveBooking(deps, approvalToken(booking), {})).booking;
    const read = async (id: string) => (await getBooking(deps, shop, { booking_id: id })).booking;
    const sessionOf = (bookingId: string) => {
      const session = [...stripe.sessions.values()].find((s) => s.bookingId === bookingId);
      if (!session) throw new Error(`No checkout session for ${bookingId}`);
      return session;
    };
    /** A Trim approved and paid for, read back: confirmed, deposit held. */
    const paid = async (start: string) => {
      const waiting = await approve(await hold(start));
      const intent = stripe.pay(sessionOf(waiting.id).id);
      return { booking: await read(waiting.id), intent };
    };
    const stamps = async (id: string) =>
      (await sql<{ status: string; completed_at: Date | null }[]>`select status, completed_at from bookings where id = ${id}::uuid`)[0];

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Nightly Shop', ${zone})`;
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
      if (runIds.length > 0) await sql`delete from nightly_runs where id in ${sql(runIds)}`;
      await closePostgresClients();
    });

    it("expires a lapsed hold and an unpaid deposit, completes a past booking (released), leaves a future one; twice is a no-op", async () => {
      setNow(time(0, 0, 9));
      const past = await paid(time(0, 1, 10)); // Wed 10:00–10:30
      const unpaid = await approve(await hold(time(0, 1, 11))); // pay_by Tue 09:30
      const lapsed = await hold(time(0, 1, 12)); // approve_by Tue 09:10
      const future = await paid(time(0, 3, 10)); // Fri

      setNow(time(0, 2, 3)); // Thu 03:00
      expect(await tidyShop(deps, shop)).toEqual({ expired: 2, completed: 1, depositsReleased: 2, failures: 0 });

      expect(await read(past.booking.id)).toMatchObject({ status: "completed", deposit: { state: "released" } });
      expect(await stamps(past.booking.id)).toEqual({ status: "completed", completed_at: expect.any(Date) });
      expect(stripe.intents.get(past.intent)).toBe("canceled");
      const completedEvent = (await store.listEvents(past.booking.id)).find((e) => e.type === "completed");
      expect(completedEvent).toMatchObject({ actor: "system", data: { from: "confirmed", to: "completed", depositEffect: "released", depositCollected: true } });
      expect(await read(unpaid.id)).toMatchObject({ status: "expired", deposit: { state: "released" } });
      expect(sessionOf(unpaid.id).status).toBe("expired");
      expect((await read(lapsed.id)).status).toBe("expired");
      expect(await read(future.booking.id)).toMatchObject({ status: "confirmed", deposit: { state: "held" } });

      const eventCount = (await sql<{ n: number }[]>`
        select count(*)::int as n from events e join bookings b on b.id = e.booking_id where b.shop_slug = ${shop}
      `)[0].n;
      expect(await tidyShop(deps, shop)).toEqual({ expired: 0, completed: 0, depositsReleased: 0, failures: 0 });
      const eventCountAfter = (await sql<{ n: number }[]>`
        select count(*)::int as n from events e join bookings b on b.id = e.booking_id where b.shop_slug = ${shop}
      `)[0].n;
      expect(eventCountAfter).toBe(eventCount);
    });

    it("listBookings filters by status; listShops includes the shop", async () => {
      setNow(time(1, 0, 9));
      const confirmed = await paid(time(1, 1, 10));
      const waiting = await approve(await hold(time(1, 1, 11)));
      const ids = async (statuses?: Booking["status"][]) =>
        (await store.listBookings(shop, { start: new Date(time(1, 0, 0)), end: new Date(time(2, 0, 0)) }, statuses)).map((b) => b.id);

      expect(await ids()).toEqual([confirmed.booking.id, waiting.id]);
      expect(await ids(["confirmed"])).toEqual([confirmed.booking.id]);
      expect(await ids(["awaiting_deposit", "awaiting_approval"])).toEqual([waiting.id]);
      expect((await store.listBookings(shop, ALL_TIME, ["no_show"])).length).toBe(0);
      expect((await store.listShops()).map((s) => s.slug)).toContain(shop);
    });

    it("recordNightlyRun stores a run (ran_at from the database) and lastNightlyRun reads the newest", async () => {
      const recorded = await store.recordNightlyRun({ expired: 3, completed: 4, depositsReleased: 2, failures: 1 });
      const [row] = await sql<{ id: string }[]>`select id::text as id from nightly_runs order by ran_at desc, id desc limit 1`;
      runIds.push(row.id);
      expect(recorded).toEqual({ ranAt: expect.stringMatching(/Z$/), expired: 3, completed: 4, depositsReleased: 2, failures: 1 });
      expect(Math.abs(Date.parse(recorded.ranAt) - Date.now())).toBeLessThan(60_000);
      expect(await store.lastNightlyRun()).toEqual(recorded);
    });
  });
}
