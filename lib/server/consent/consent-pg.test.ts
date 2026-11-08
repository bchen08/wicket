import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { FrontDeskError } from "../frontdesk/errors";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "../frontdesk/postgres-store";
import { book, cancelBooking, getAvailability, getBooking } from "../frontdesk/service";
import { approvalToken, customerOf, recordingNotifier, withBaseUrl } from "../frontdesk/test-support";
import { approveBooking, declineBooking, getApprovalView } from "./approvals";

// Ring 1b's consent flow against a real Postgres, through the approval use cases (what the
// /api/approvals/[token]/* routes call) and book, when DATABASE_URL_TEST points at a database with
// 0001, 0002, 0003 and the seed applied (see docs/database.md). Like flow-pg.test.ts it never touches
// Hart's: a throwaway shop (one staff member, Tue–Sat 09:00–17:00, a 30-minute service with a deposit),
// bookings only in 2099, each test in its own week, and everything deleted in afterAll. Opening the
// link and approving is the consent (no phone code until Ring 1c); a phone number is optional. Phone
// numbers carry a 6-digit prefix of this run's own.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Consent flow on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the consent flow against a real database", () => {});
  });
} else {
  describe("Consent flow on Postgres (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const sql = getPostgresClient(url);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-consent-${run}`;
    const staffId = `vitest-consent-${run}-sam`;
    const zone = "America/New_York";
    /** 6 digits of this run's own, in every phone number this file uses. */
    const PHONE_PREFIX = String(100000 + Math.floor(Math.random() * 900000));

    /** A clock the tests move. */
    let now = new Date();
    const clock: Clock = { now: () => new Date(now.getTime()) };
    const notifier = recordingNotifier();
    const deps = withBaseUrl({ catalog: store, store, clock, notifier });

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

    const hold = async (start: string, customer = "Consent Test"): Promise<Booking> =>
      (await book(deps, shop, { service_id: "trim", start, customer_name: customer }, "vitest consent")).booking;
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
    /** A phone number of this run's own, e.g. phone(7) = "+1<prefix>0007". */
    const phone = (n: number) => `+1${PHONE_PREFIX}${String(n).padStart(4, "0")}`;
    const customerPhoneOf = async (id: string) =>
      (await sql<{ customer_phone: string | null }[]>`select customer_phone from bookings where id = ${id}::uuid`)[0].customer_phone;

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Consent Shop', ${zone})`;
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

    it("the approve path: open the link → approve (with a phone) → confirmed and approved; owner alerted once", async () => {
      setNow(time(0, 0, 9));
      const alertsBefore = notifier.alerts.length;
      const booking = await hold(time(0, 1, 10), "Maya Lopez");
      expect(booking.status).toBe("awaiting_approval");
      const token = approvalToken(booking);
      const view = await getApprovalView(deps, token);
      expect(view).toMatchObject({
        status: "pending",
        shop: { slug: shop },
        serviceName: "Trim",
        priceCents: 2000,
        depositCents: 500,
        customerName: "Maya Lopez",
        agentName: "vitest consent",
        expiresAt: time(0, 0, 9, 10),
      });
      expect(view).not.toHaveProperty("codeSentTo");

      // Typed with separators, as a person might: stored normalized, as plain E.164.
      const typed = `+1 ${PHONE_PREFIX.slice(0, 3)}-${PHONE_PREFIX.slice(3)}-0123`;
      const { booking: approved } = await approveBooking(deps, token, { phone: typed });
      expect(approved).toEqual({
        ...booking,
        approval: undefined,
        status: "confirmed",
        customer: customerOf("Maya Lopez", true, phone(123)),
        // No Stripe in these deps: confirmed without collecting the deposit.
        deposit: { amountCents: 500, state: "not_collected" },
      });
      expect(approved).not.toHaveProperty("approval");
      expect((await getBooking(deps, shop, { booking_id: booking.id })).booking).toEqual(approved);
      expect((await getApprovalView(deps, token)).status).toBe("approved");
      expect(await customerPhoneOf(booking.id)).toBe(phone(123));

      const [approval] = await sql<{ decision: string; decided_at: Date; token: string }[]>`
        select decision, decided_at, token from approvals where booking_id = ${booking.id}::uuid
      `;
      expect(approval).toMatchObject({ decision: "approved", decided_at: new Date(time(0, 0, 9)) });
      expect(approval.token).toBe(token); // stored as it is

      const events = await store.listEvents(booking.id);
      expect(events.map((e) => [e.type, e.actor])).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);
      expect(events[1].data).toEqual({
        from: "awaiting_approval",
        to: "confirmed",
        depositEffect: "none",
        depositCollected: false,
      });
      expect(notifier.alerts.slice(alertsBefore).map((a) => [a.kind, a.booking.id, a.booking.status])).toEqual([
        ["booking_confirmed", booking.id, "confirmed"],
      ]);
      // Recorded in the alerts table.
      const [recorded] = await deps.store.listAlerts(shop, 1);
      expect(recorded).toMatchObject({ shopSlug: shop, bookingId: booking.id, kind: "booking_confirmed", channel: "log", status: "logged" });

      // Any answer now: approval_closed, and the owner isn't told twice.
      expect((await failure(approveBooking(deps, token, {}))).code).toBe("approval_closed");
      expect((await failure(declineBooking(deps, token))).code).toBe("approval_closed");
      expect(notifier.alerts.length - alertsBefore).toBe(1);
    });

    it("approve without a phone: confirmed and approved, no customer.phone, nothing stored; a bad phone writes nothing", async () => {
      setNow(time(0, 0, 9));
      const booking = await hold(time(0, 1, 11));
      const token = approvalToken(booking);
      expect((await failure(approveBooking(deps, token, { phone: "555-0123" }))).code).toBe("invalid_request");
      expect((await store.getBooking(booking.id))?.status).toBe("awaiting_approval");
      expect(await eventsOf(booking.id)).toEqual([["booked", "agent"]]);

      const { booking: approved } = await approveBooking(deps, token);
      expect(approved).toMatchObject({ status: "confirmed", customer: { displayName: "Consent Test", approved: true } });
      expect(approved.customer).not.toHaveProperty("phone");
      expect(await customerPhoneOf(booking.id)).toBeNull();
      const [event] = (await store.listEvents(booking.id)).slice(1);
      expect(event.data).not.toHaveProperty("phone");
    });

    it("two approvals racing: exactly one confirms, the other is approval_closed, one owner alert", async () => {
      setNow(time(0, 0, 9));
      const alertsBefore = notifier.alerts.length;
      const booking = await hold(time(0, 1, 12));
      const token = approvalToken(booking);
      const results = await Promise.allSettled([
        approveBooking(deps, token, { phone: phone(1) }),
        approveBooking(deps, token, { phone: phone(2) }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected.map((r) => (r.reason as FrontDeskError).code)).toEqual(["approval_closed"]);
      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);
      expect(notifier.alerts.length - alertsBefore).toBe(1);
    });

    it("lazy expiry: a lapsed hold doesn't block a new book for its slot; it becomes expired with exactly one event", async () => {
      setNow(time(1, 0, 9));
      const start = time(1, 1, 11);
      const stale = await hold(start);
      setNow(time(1, 0, 9, 10)); // the deadline

      const next = await hold(start, "Next Person");
      expect(next).toMatchObject({ start, status: "awaiting_approval" });
      // book expired the stale hold just before inserting.
      expect((await store.getBooking(stale.id))?.status).toBe("expired");
      expect(await eventsOf(stale.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      // Reading it, and its approval page, expire nothing more; the link is closed.
      expect((await getBooking(deps, shop, { booking_id: stale.id })).booking.status).toBe("expired");
      expect((await getApprovalView(deps, approvalToken(stale))).status).toBe("expired");
      expect((await failure(approveBooking(deps, approvalToken(stale), { phone: phone(1) }))).code).toBe("approval_expired");
      expect(await store.listEvents(stale.id)).toHaveLength(2);
    });

    it("lazy expiry on read: opening the approval page of a lapsed hold expires that booking once", async () => {
      setNow(time(2, 0, 9));
      const booking = await hold(time(2, 1, 12));
      setNow(time(2, 0, 9, 11));
      const token = approvalToken(booking);
      expect((await getApprovalView(deps, token)).status).toBe("expired");
      expect((await getApprovalView(deps, token)).status).toBe("expired");
      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      expect((await failure(approveBooking(deps, token))).code).toBe("approval_expired");
      expect((await failure(declineBooking(deps, token))).code).toBe("approval_expired");
    });

    it("two agents racing for a lapsed hold's slot: one new hold, one slot_taken, and the old hold expires once", async () => {
      setNow(time(3, 0, 9));
      const start = time(3, 1, 13);
      const stale = await hold(start);
      setNow(time(3, 0, 10));
      const results = await Promise.allSettled([hold(start, "Agent A's person"), hold(start, "Agent B's person")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      expect(reason).toMatchObject({ code: "slot_taken" });
      expect(await eventsOf(stale.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
    });

    it("decline → cancelled by the customer, the slot freed, one booking_cancelled owner alert", async () => {
      setNow(time(4, 0, 9));
      const alertsBefore = notifier.alerts.length;
      const start = time(4, 1, 14);
      const booking = await hold(start);
      const { booking: declined } = await declineBooking(deps, approvalToken(booking));
      expect(declined).toMatchObject({ id: booking.id, status: "cancelled", customer: { approved: false } });
      const [row] = await sql<{ cancelled_by: string; decision: string }[]>`
        select b.cancelled_by, a.decision from bookings b join approvals a on a.booking_id = b.id where b.id = ${booking.id}::uuid
      `;
      expect(row).toEqual({ cancelled_by: "customer", decision: "declined" });
      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["declined", "customer"],
      ]);
      const wednesday = { service_id: "trim", from: time(4, 1, 0), to: time(4, 2, 0), limit: 50 };
      expect((await getAvailability(deps, shop, wednesday)).slots.map((s) => s.start)).toContain(start);
      expect(await hold(start, "Someone Else")).toMatchObject({ status: "awaiting_approval" });
      expect(notifier.alerts.slice(alertsBefore).map((a) => [a.kind, a.booking.id, a.cancelledBy])).toEqual([
        ["booking_cancelled", booking.id, "customer"],
      ]);
    });

    it("an agent cancelling the hold closes the link: the page shows expired, answers are approval_closed", async () => {
      setNow(time(5, 0, 9));
      const booking = await hold(time(5, 1, 10));
      const token = approvalToken(booking);
      const cancelled = await cancelBooking(deps, shop, { booking_id: booking.id });
      expect(cancelled).toMatchObject({ booking: { status: "cancelled" }, depositEffect: "released", depositCollected: false });
      expect((await getApprovalView(deps, token)).status).toBe("expired");
      expect((await failure(approveBooking(deps, token))).code).toBe("approval_closed");
      expect((await failure(declineBooking(deps, token))).code).toBe("approval_closed");
      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["cancelled", "agent"],
      ]);
    });
  });
}
