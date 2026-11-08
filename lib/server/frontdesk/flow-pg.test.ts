import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { FrontDeskError } from "./errors";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book, cancelBooking, getAvailability, getBooking, transitionBooking } from "./service";
import { approveAsCustomer, recordingNotifier, TEST_CONSENT, withConsent } from "./test-support";

// Issue #8's lifecycle flow against a real Postgres, through the service layer (what
// the MCP tools and owner routes call), when DATABASE_URL_TEST points at a database with 0001, 0002,
// 0003 and the seed applied (see docs/database.md). Other test files share that database and read
// Hart's rows, so this file never touches Hart's: it makes a throwaway shop (one staff member working
// Tue–Sat 09:00–17:00, a 30-minute service with a deposit and a 20-minute one without, and a policies
// row like Hart's), books only in 2099, and deletes everything it made in afterAll.
// Ring 1b: book places a hold; a booking is confirmed when the person approves it through the link
// (approveAsCustomer, through the approval use case), and the owner is alerted then. book and cancel
// take no idempotency key: a repeated book of a held time is slot_taken, a repeated cancel
// not_cancellable. Phone numbers carry a 6-digit prefix of this run's own.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Front Desk flow on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the lifecycle flow against a real database", () => {});
  });
} else {
  describe("Front Desk flow on Postgres (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const sql = getPostgresClient(url);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-flow-${run}`;
    const staffId = `vitest-flow-${run}-sam`;
    const zone = "America/New_York";

    /** A clock the tests move. */
    let now = new Date();
    const clock: Clock = { now: () => new Date(now.getTime()) };
    const notifier = recordingNotifier();
    const deps = withConsent({
      catalog: store,
      store,
      clock,
      notifier,
      consent: TEST_CONSENT,
    });
    /** 6 digits of this run's own, in every phone number this file uses. */
    const PHONE_PREFIX = String(100000 + Math.floor(Math.random() * 900000));
    /** A different phone for each approval. */
    let phones = 0;
    const phoneNumber = () => `+1${PHONE_PREFIX}${String(1000 + phones++).slice(-4)}`;
    const approve = (booking: Booking) => approveAsCustomer(deps, booking, phoneNumber());

    // A random Tuesday in 2099; each test books in its own week after it.
    const firstTuesday = DateTime.fromObject({ year: 2099, month: 1, day: 6 }, { zone })
      .plus({ weeks: Math.floor(Math.random() * 30) })
      .set({ weekday: 2 })
      .startOf("day");
    /** `hh:mm` on Tuesday (+ `dayOffset` days) of week `week`, as an RFC 3339 string in New York. */
    const time = (week: number, dayOffset: number, hh: number, mm = 0) =>
      firstTuesday.plus({ weeks: week, days: dayOffset }).set({ hour: hh, minute: mm }).toISO({ suppressMilliseconds: true })!;
    const setNow = (iso: string) => {
      now = new Date(iso);
    };
    const dayRange = (week: number, dayOffset: number) => ({
      start: new Date(time(week, dayOffset, 0)),
      end: new Date(time(week, dayOffset + 1, 0)),
    });

    const bookTrim = (start: string, customer = "E2E Flow") =>
      book(deps, shop, { service_id: "trim", start, customer_name: customer }, "vitest flow");
    const cancel = (bookingId: string) => cancelBooking(deps, shop, { booking_id: bookingId });
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => {
          throw new Error("expected a FrontDeskError");
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(FrontDeskError);
          return err as FrontDeskError;
        },
      );
    const eventsOf = async (id: string) => (await store.listEvents(id)).map((e) => [e.type, e.actor]);

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Flow Shop', ${zone})`;
      await sql`insert into staff (id, shop_slug, name) values (${staffId}, ${shop}, 'Sam')`;
      await sql`
        insert into weekly_hours (staff_id, weekday, opens, closes)
        select ${staffId}, day, time '09:00', time '17:00' from generate_series(2, 6) as day
      `;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 500, 1), (${shop}, 'shave', 'Shave', 20, 1500, 0, 2)
      `;
      await sql`
        insert into policies (
          shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone,
          deposit_rule, late_cancel_rule, no_show_rule
        ) values (${shop}, 120, 30, 6, 24, false, '+1 555-0100', 'Held at booking.', 'Inside 24 hours we keep it.', 'We keep it.')
      `;
    });

    afterAll(async () => {
      await sql`delete from bookings where shop_slug = ${shop}`; // events and approvals cascade
      await sql`delete from shops where slug = ${shop}`; // staff, hours, services and policies cascade
      await closePostgresClients();
    });

    it("book: one hold, one booked event, the link; booking the same time again is slot_taken; one owner alert, on approval", async () => {
      setNow(time(0, 0, 10));
      const alertsBefore = notifier.alerts.length;
      const start = time(0, 1, 10);
      const first = await bookTrim(start);
      expect(first.booking).toMatchObject({
        shopSlug: shop,
        start,
        status: "awaiting_approval",
        depositCents: 500,
        approval: { url: expect.stringMatching(/^http:\/\/localhost:3000\/approve\/[A-Za-z0-9_-]{43}$/) },
      });

      // A retry (the same call again) can't double-book: the hold is in the way.
      const again = await failure(bookTrim(start));
      expect(again.code).toBe("slot_taken");

      const listed = await store.listBookings(shop, dayRange(0, 1));
      expect(listed.map((b) => b.id)).toEqual([first.booking.id]);
      expect(await eventsOf(first.booking.id)).toEqual([["booked", "agent"]]);
      expect(notifier.alerts.length - alertsBefore).toBe(0); // a hold isn't news for the owner
      const stored: Booking = { ...first.booking };
      delete stored.approval; // reads never show the link
      expect((await getBooking(deps, shop, { booking_id: first.booking.id })).booking).toEqual(stored);

      const phone = phoneNumber();
      const approved = await approveAsCustomer(deps, first.booking, phone);
      expect(approved).toMatchObject({ id: first.booking.id, status: "confirmed", customer: { verified: true, phoneLast4: phone.slice(-4) } });
      expect(notifier.alerts.length - alertsBefore).toBe(1);
      expect((await getBooking(deps, shop, { booking_id: first.booking.id })).booking).toEqual(approved);
      const [row] = await sql<{ customer_phone: string | null }[]>`select customer_phone from bookings where id = ${first.booking.id}::uuid`;
      expect(row.customer_phone).toBe(phone);
    });

    it("approve without a phone: confirmed and verified, no phoneLast4, nothing stored", async () => {
      setNow(time(0, 0, 10));
      const held = await bookTrim(time(0, 1, 13));
      const approved = await approveAsCustomer(deps, held.booking, null);
      expect(approved).toMatchObject({ status: "confirmed", customer: { verified: true } });
      expect(approved.customer).not.toHaveProperty("phoneLast4");
      const [row] = await sql<{ customer_phone: string | null }[]>`select customer_phone from bookings where id = ${held.booking.id}::uuid`;
      expect(row.customer_phone).toBeNull();
    });

    it("cancel at least 24 hours ahead → released (the slot is offered again); inside the window → captured; no deposit → none", async () => {
      setNow(time(1, 0, 9));
      const early = await bookTrim(time(1, 1, 10)); // 25 hours ahead
      const late = await bookTrim(time(1, 1, 11));
      const free = await book(
        deps,
        shop,
        { service_id: "shave", start: time(1, 1, 12), customer_name: "E2E Shave" },
        "vitest flow",
      );
      const wednesday = { service_id: "trim", from: time(1, 1, 0), to: time(1, 2, 0), limit: 50 };
      expect((await getAvailability(deps, shop, wednesday)).slots.map((s) => s.start)).not.toContain(time(1, 1, 10));
      // The cancellation policy applies to bookings the person approved.
      const [earlyOk] = await Promise.all([approve(early.booking), approve(late.booking), approve(free.booking)]);

      const released = await cancel(early.booking.id);
      expect(released).toMatchObject({
        booking: { ...earlyOk, status: "cancelled" },
        depositEffect: "released",
        depositCollected: false,
      });
      expect((await getAvailability(deps, shop, wednesday)).slots.map((s) => s.start)).toContain(time(1, 1, 10));

      setNow(time(1, 0, 12)); // 23 hours before 11:00
      const captured = await cancel(late.booking.id);
      expect(captured).toMatchObject({ booking: { status: "cancelled" }, depositEffect: "captured", depositCollected: false });
      expect((await cancel(free.booking.id)).depositEffect).toBe("none");

      const events = await store.listEvents(late.booking.id);
      expect(events.map((e) => [e.type, e.actor])).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
        ["cancelled", "agent"],
      ]);
      expect(events[2].data).toEqual({ from: "confirmed", to: "cancelled", depositEffect: "captured", depositCollected: false });
      const [row] = await sql<{ cancelled_by: string; cancelled_at: Date | null }[]>`
        select cancelled_by, cancelled_at from bookings where id = ${late.booking.id}::uuid
      `;
      expect(row).toMatchObject({ cancelled_by: "agent", cancelled_at: expect.any(Date) });
    });

    it("cancel after the start → not_cancellable, nothing written", async () => {
      setNow(time(2, 0, 9));
      const booked = await bookTrim(time(2, 0, 13));
      await approve(booked.booking);
      setNow(time(2, 0, 13, 5));
      const err = await failure(cancel(booked.booking.id));
      expect(err.code).toBe("not_cancellable");
      expect(err.details).toMatchObject({ status: "confirmed", booking_id: booked.booking.id });
      expect((await store.getBooking(booked.booking.id))?.status).toBe("confirmed");
      expect(await eventsOf(booked.booking.id)).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);
    });

    it("owner no-show after the start → no_show, captured, with a no_show event by the owner", async () => {
      setNow(time(2, 0, 9));
      const booked = await bookTrim(time(2, 0, 14));
      // Not while it's only a hold, and not before the start.
      expect((await failure(transitionBooking(deps, shop, booked.booking.id, "mark_no_show", "owner"))).code).toBe(
        "invalid_request",
      );
      const approved = await approve(booked.booking);
      expect((await failure(transitionBooking(deps, shop, booked.booking.id, "mark_no_show", "owner"))).code).toBe(
        "invalid_request",
      );

      setNow(time(2, 0, 14, 30));
      const result = await transitionBooking(deps, shop, booked.booking.id, "mark_no_show", "owner");
      expect(result).toEqual({ booking: { ...approved, status: "no_show" }, depositEffect: "captured", depositCollected: false });
      const events = await store.listEvents(booked.booking.id);
      expect(events.map((e) => [e.type, e.actor])).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
        ["no_show", "owner"],
      ]);
      expect(events[2].data).toEqual({ from: "confirmed", to: "no_show", depositEffect: "captured", depositCollected: false });
      // Final: the agent can't cancel it now.
      expect((await failure(cancel(booked.booking.id))).code).toBe("not_cancellable");
    });

    it("two concurrent cancels: exactly one succeeds, with exactly one cancelled event", async () => {
      setNow(time(3, 0, 9));
      const booked = await bookTrim(time(3, 1, 10));
      const results = await Promise.allSettled([cancel(booked.booking.id), cancel(booked.booking.id)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(FrontDeskError);
      expect(rejected[0].reason).toMatchObject({ code: "not_cancellable", details: { status: "cancelled" } });
      expect(await eventsOf(booked.booking.id)).toEqual([
        ["booked", "agent"],
        ["cancelled", "agent"],
      ]);
    });

    it("two concurrent book calls for the same time: one hold, one slot_taken, and no owner alert", async () => {
      setNow(time(3, 0, 9));
      const alertsBefore = notifier.alerts.length;
      const start = time(3, 1, 14);
      const results = await Promise.allSettled([bookTrim(start, "E2E A"), bookTrim(start, "E2E B")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected.map((r) => (r.reason as FrontDeskError).code)).toEqual(["slot_taken"]);
      expect((await store.listBookings(shop, dayRange(3, 1))).filter((x) => x.start === start)).toHaveLength(1);
      expect(notifier.alerts.length - alertsBefore).toBe(0);
    });

    // Regression: more concurrent writes than postgres.js pools connections (10) must all settle, with
    // no request holding a connection while it waits for another.
    const parallel: string[] = [];

    it("12 concurrent book calls for 12 free starts all settle", { timeout: 15_000 }, async () => {
      setNow(time(4, 0, 12));
      const starts = Array.from({ length: 12 }, (_, i) => time(4, 1, 9 + Math.floor(i / 2), (i % 2) * 30)); // 09:00 … 14:30
      const results = await Promise.allSettled(starts.map((start, i) => bookTrim(start, `E2E Parallel ${i}`)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failed.map((r) => String(r.reason))).toEqual([]);
      for (const r of results) if (r.status === "fulfilled") parallel.push(r.value.booking.id);
      expect(new Set(parallel).size).toBe(12);
      expect((await store.listBookings(shop, dayRange(4, 1))).map((b) => b.start)).toEqual(starts);
    });

    it("12 concurrent cancels of those bookings all settle", { timeout: 15_000 }, async () => {
      expect(parallel).toHaveLength(12);
      setNow(time(4, 0, 12));
      const results = await Promise.allSettled(parallel.map((id) => cancel(id)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failed.map((r) => String(r.reason))).toEqual([]);
      const bookings = await store.listBookings(shop, dayRange(4, 1));
      expect(bookings.map((b) => b.status)).toEqual(Array(12).fill("cancelled"));
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count from events where type = 'cancelled' and booking_id = any(${parallel}::uuid[])
      `;
      expect(count).toBe(12);
    });
  });
}
