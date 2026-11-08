import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Policies } from "../../types/frontdesk";
import { fixedClock } from "../clock";
import { newApprovalToken } from "../consent/crypto";
import { expiredEventData, SlotTakenError, type NewBooking, type NewBookingEvent } from "./booking-store";
import { DepositExceedsPriceError, DuplicateServiceError } from "./catalog";
import { FrontDeskError } from "./errors";
import { SEED } from "./memory-store";
import { DEFAULT_POLICIES } from "./policies";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book } from "./service";
import { customerOf, holdFields, recordingNotifier, withBaseUrl } from "./test-support";

// Runs against a real Postgres only when DATABASE_URL_TEST points at a database with
// every migration in supabase/migrations/ (0001–0004) and supabase/seed.sql applied
// (see docs/database.md).
// Use a scratch database. Other test files may share it, so this file only adds rows of its own and
// deletes them afterwards: bookings in 2099 and a throwaway shop (with its own staff member and
// service) for the lifecycle, consent and owner-write tests, so Hart's seeded data is only read, never
// changed.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Postgres store", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the store tests against a real database", () => {});
  });
} else {
  describe("Postgres store (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const sql = getPostgresClient(url);
    const created: string[] = [];
    const run = Math.random().toString(16).slice(2, 10);
    // A random day in 2099, so parallel or repeated runs don't collide with each other or real data.
    const day = new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 300) * 86_400_000);
    const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000);
    /** Every hold createBooking makes in this file lapses here (two days later) unless a test says otherwise. */
    const HELD_UNTIL = at(48);
    /** When a booking this file inserts as awaiting_deposit lapses. */
    const PAY_UNTIL = at(49);
    const input =(start: Date, end: Date, serviceId = "haircut"): NewBooking => ({
      shopSlug: "harts",
      serviceId,
      staffId: "dana",
      start,
      end,
      customerName: "Postgres Test",
      agentName: "vitest",
      depositCents: 1000,
      ...holdFields(HELD_UNTIL),
    });

    // The throwaway shop. Deleting it cascades to its staff, hours, services, policies and blocks.
    const shop = `vitest-${run}`;
    const staffId = `vitest-${run}-sam`;
    const ours = (start: Date, end: Date, depositCents = 500): NewBooking => ({
      shopSlug: shop,
      serviceId: "trim",
      staffId,
      start,
      end,
      customerName: "Postgres Test",
      agentName: "vitest",
      depositCents,
      ...holdFields(HELD_UNTIL),
    });
    const DAY = { start: at(0), end: at(24) };
    const cancelEvent = (actor: NewBookingEvent["actor"] = "agent"): NewBookingEvent => ({
      actor,
      type: "cancelled",
      data: { from: "awaiting_approval", to: "cancelled", depositEffect: "released", depositCollected: false },
    });

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Shop', 'America/New_York')`;
      await sql`insert into staff (id, shop_slug, name) values (${staffId}, ${shop}, 'Sam')`;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 500, 1)
      `;
    });

    afterAll(async () => {
      if (created.length > 0) {
        await sql`delete from bookings where id = any(${created}::uuid[])`; // events and approvals cascade
      }
      await sql`delete from bookings where shop_slug = ${shop}`;
      await sql`delete from shops where slug = ${shop}`;
      await closePostgresClients();
    });

    it("0003 left no customers or otp_challenges tables, and approvals stores the token itself", async () => {
      const [row] = await sql<{ customers: string | null; otp: string | null }[]>`
        select to_regclass('public.customers')::text as customers, to_regclass('public.otp_challenges')::text as otp
      `;
      expect(row).toEqual({ customers: null, otp: null });
      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'approvals' order by ordinal_position
      `;
      expect(columns.map((c) => c.column_name)).toEqual(["booking_id", "token", "created_at", "decided_at", "decision"]);
    });

    it("0004 dropped idempotency_keys and added alerts and policies.owner_email", async () => {
      const [row] = await sql<{ keys: string | null; alerts: string | null }[]>`
        select to_regclass('public.idempotency_keys')::text as keys, to_regclass('public.alerts')::text as alerts
      `;
      expect(row).toEqual({ keys: null, alerts: "alerts" });
      const [policies] = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'policies' and column_name = 'owner_email'
      `;
      expect(policies.n).toBe(1);
    });

    it("recordAlert stores an alert; listAlerts returns the shop's newest first, limited, in its zone", async () => {
      const booking = await store.createBooking(ours(at(9), at(9, 30)));
      const recordedAlerts = [];
      for (const status of ["logged", "sent", "failed"] as const) {
        recordedAlerts.push(
          await store.recordAlert({
            shopSlug: shop,
            bookingId: booking.id.toUpperCase(), // ids are matched however they're written
            kind: status === "failed" ? "booking_cancelled" : "booking_confirmed",
            channel: status === "logged" ? "log" : "email",
            recipient: status === "logged" ? null : "owner@example.com",
            status,
            error: status === "failed" ? "Resend answered HTTP 403: nope" : null,
          }),
        );
      }
      expect(recordedAlerts[2]).toEqual({
        id: expect.stringMatching(/^\d+$/),
        shopSlug: shop,
        bookingId: booking.id,
        kind: "booking_cancelled",
        channel: "email",
        recipient: "owner@example.com",
        status: "failed",
        error: "Resend answered HTTP 403: nope",
        createdAt: expect.stringMatching(/-0[45]:00$/), // the shop's zone
      });
      expect(await store.listAlerts(shop, 50)).toEqual([...recordedAlerts].reverse());
      expect((await store.listAlerts(shop, 2)).map((a) => a.status)).toEqual(["failed", "sent"]);
      expect(await store.listAlerts("nope", 50)).toEqual([]);
      // The checks refuse a value the contract doesn't allow.
      await expect(
        sql`insert into alerts (shop_slug, booking_id, kind, channel, status) values (${shop}, ${booking.id}::uuid, 'booking_held', 'log', 'logged')`,
      ).rejects.toMatchObject({ code: "23514" });
      // Deleting the booking deletes its alerts.
      await sql`delete from bookings where id = ${booking.id}::uuid`;
      expect(await store.listAlerts(shop, 50)).toEqual([]);
    });

    it("reads the seeded shop, services, split hours and policies", async () => {
      expect(await store.getShop("harts")).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
      expect((await store.listServices("harts")).map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard"]);
      const [dana] = await store.getStaffHours("harts");
      expect(dana.staffName).toBe("Dana");
      expect(dana.weekly.filter((w) => w.weekday === 6)).toEqual([
        { weekday: 6, open: "09:00", close: "12:00" },
        { weekday: 6, open: "12:30", close: "17:00" },
      ]);
      // The memory store's SEED must match supabase/seed.sql.
      expect(await store.getPolicies("harts")).toEqual(SEED.policies.harts);
      expect(await store.getPolicies("nope")).toBeNull();
    });

    it("stores a booking, then refuses an overlapping one with SlotTakenError (23P01)", async () => {
      const first = await store.createBooking(input(at(15), at(15, 30)));
      created.push(first.id);
      // A hold awaiting approval holds the time like a confirmed booking (the no_overlap constraint).
      expect(first).toMatchObject({ status: "awaiting_approval", serviceName: "Haircut", depositCents: 1000, staffId: "dana" });

      // haircut-beard 14:45–15:30 overlaps 15:00–15:30.
      await expect(store.createBooking(input(at(14, 45), at(15, 30), "haircut-beard"))).rejects.toBeInstanceOf(
        SlotTakenError,
      );

      // Back to back is allowed (half-open ranges).
      const next = await store.createBooking(input(at(15, 30), at(16)));
      created.push(next.id);

      const busy = await store.getBusyIntervals("harts", { start: at(15, 10), end: at(15, 40) });
      expect(busy.map((b) => b.start.getTime())).toEqual([at(15).getTime(), at(15, 30).getTime()]);
      expect(busy.map((b) => b.kind)).toEqual(["booking", "booking"]);
      expect(busy.map((b) => b.heldUntil?.getTime())).toEqual([HELD_UNTIL.getTime(), HELD_UNTIL.getTime()]);

      const listed = await store.listBookings("harts", { start: at(0), end: at(24) });
      expect(listed.map((b) => b.id)).toEqual([first.id, next.id]);
    });

    it("lets exactly one of two simultaneous overlapping inserts win", async () => {
      const results = await Promise.allSettled([
        store.createBooking(input(at(10), at(10, 30))),
        store.createBooking(input(at(10, 15), at(11), "haircut-beard")),
      ]);
      for (const r of results) if (r.status === "fulfilled") created.push(r.value.id);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotTakenError);
    });

    it("book(): two agents racing for the same slot get one booking and one slot_taken", async () => {
      // A Saturday in 2099 (Dana works 12:30–17:00), different from `day` above.
      const saturday = DateTime.fromObject({ year: 2099, month: 12, day: 1 }, { zone: "America/New_York" })
        .plus({ weeks: Math.floor(Math.random() * 4) })
        .set({ weekday: 6 });
      const start = saturday.set({ hour: 13, minute: 15 }).toISO()!;
      const deps = withBaseUrl({
        catalog: store,
        store,
        clock: fixedClock(saturday.minus({ days: 1 }).toJSDate()),
        notifier: recordingNotifier(),
      });
      const results = await Promise.allSettled([
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent A's customer" }, "vitest A"),
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent B's customer" }, "vitest B"),
      ]);
      for (const r of results) if (r.status === "fulfilled") created.push(r.value.booking.id);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // The winner holds the slot, awaiting approval.
      expect((results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ booking: { status: string } }>).value.booking.status).toBe(
        "awaiting_approval",
      );
      const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(FrontDeskError);
      expect((reason as FrontDeskError).code).toBe("slot_taken");
    });

    // ---- Lifecycle (the throwaway shop) ----

    it("createBooking stores the hold, its deposit snapshot, its approval and a booked event in the same statement", async () => {
      const fields = ours(at(1), at(1, 30), 777);
      const booking = await store.createBooking(fields);
      expect(booking).toMatchObject({
        shopSlug: shop,
        serviceName: "Trim",
        depositCents: 777,
        status: "awaiting_approval",
        customer: customerOf("Postgres Test", false),
        // The store knows the token but not the request's origin: the link is a path until the service layer adds it.
        approval: { url: `/approve/${fields.approvalToken}`, expiresAt: expect.stringMatching(/-0[45]:00$/) },
      });
      const events = await store.listEvents(booking.id);
      expect(events).toEqual([
        {
          id: expect.stringMatching(/^\d+$/),
          bookingId: booking.id,
          at: expect.stringMatching(/-0[45]:00$/), // New York time
          actor: "agent",
          type: "booked",
          data: { status: "awaiting_approval", agentName: "vitest" },
        },
      ]);
      const [row] = await sql<{ approve_by: Date; mandate: unknown; customer_phone: string | null; token: string; decision: string | null }[]>`
        select b.approve_by, b.mandate, b.customer_phone, a.token, a.decision
        from bookings b join approvals a on a.booking_id = b.id where b.id = ${booking.id}::uuid
      `;
      expect(row).toEqual({
        approve_by: HELD_UNTIL,
        mandate: null,
        customer_phone: null,
        token: fields.approvalToken, // stored as it is
        decision: null,
      });
      expect(await store.getBooking(booking.id)).toEqual(booking);
      expect(await store.getBooking(booking.id.toUpperCase())).toEqual(booking);
      expect(await store.getBooking(crypto.randomUUID())).toBeNull();
      expect(await store.getBooking("not-a-uuid")).toBeNull();
      expect(await store.listEvents("not-a-uuid")).toEqual([]);
    });

    it("createBooking stores the mandate as jsonb and puts it in the booked event", async () => {
      const mandate = { priceCapCents: 2500, window: { from: at(0).toISOString(), to: at(24).toISOString() } };
      const booking = await store.createBooking({ ...ours(at(6, 30), at(7)), mandate });
      const [event] = await store.listEvents(booking.id);
      expect(event.data).toEqual({ status: "awaiting_approval", agentName: "vitest", mandate });
      const [row] = await sql<{ mandate: unknown }[]>`select mandate from bookings where id = ${booking.id}::uuid`;
      expect(row.mandate).toEqual(mandate);
    });

    it("transition() moves the status, writes its event and stamps the time, all in one statement", async () => {
      const booking = await store.createBooking(ours(at(2), at(2, 30)));
      const cancelled = await store.transition(booking.id, "awaiting_approval", "cancelled", cancelEvent("owner"));
      expect(cancelled).toEqual({ ...booking, approval: undefined, status: "cancelled" });

      const events = await store.listEvents(booking.id);
      expect(events.map((e) => [e.type, e.actor])).toEqual([
        ["booked", "agent"],
        ["cancelled", "owner"],
      ]);
      expect(events[1].data).toEqual(cancelEvent().data);
      const [row] = await sql<{ cancelled_at: Date; cancelled_by: string; completed_at: Date | null; at: Date }[]>`
        select b.cancelled_at, b.cancelled_by, b.completed_at, e.at
        from bookings b join events e on e.booking_id = b.id and e.type = 'cancelled'
        where b.id = ${booking.id}::uuid
      `;
      expect(row.cancelled_by).toBe("owner");
      expect(row.cancelled_at.getTime()).toBe(row.at.getTime());
      expect(row.completed_at).toBeNull();

      // The slot is free again: a new booking over it succeeds.
      await expect(store.createBooking(ours(at(2), at(2, 30)))).resolves.toMatchObject({ status: "awaiting_approval" });
    });

    it("transition() stamps completed_at and no_show_at", async () => {
      const a = await store.createBooking(ours(at(3), at(3, 30)));
      const b = await store.createBooking(ours(at(3, 30), at(4)));
      // The store doesn't judge transitions (decide() does): it moves whatever status it's told.
      await store.transition(a.id, "awaiting_approval", "completed", { actor: "owner", type: "completed", data: {} });
      await store.transition(b.id, "awaiting_approval", "no_show", { actor: "owner", type: "no_show", data: {} });
      const rows = await sql<{ id: string; status: string; completed_at: Date | null; no_show_at: Date | null; cancelled_by: string | null }[]>`
        select id::text as id, status, completed_at, no_show_at, cancelled_by from bookings
        where id in (${a.id}::uuid, ${b.id}::uuid)
      `;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(a.id)).toMatchObject({ status: "completed", completed_at: expect.any(Date), no_show_at: null, cancelled_by: null });
      expect(byId.get(b.id)).toMatchObject({ status: "no_show", completed_at: null, no_show_at: expect.any(Date), cancelled_by: null });
    });

    it("transition() returns null and writes nothing when the status isn't the expected one", async () => {
      const booking = await store.createBooking(ours(at(4, 30), at(5)));
      expect(await store.transition(booking.id, "confirmed", "cancelled", cancelEvent())).toBeNull();
      expect((await store.getBooking(booking.id))?.status).toBe("awaiting_approval");
      expect(await store.listEvents(booking.id)).toHaveLength(1);
      expect(await store.transition(crypto.randomUUID(), "awaiting_approval", "cancelled", cancelEvent())).toBeNull();
      expect(await store.transition("not-a-uuid", "awaiting_approval", "cancelled", cancelEvent())).toBeNull();
    });

    it("of two concurrent transitions exactly one wins, with exactly one event", async () => {
      const booking = await store.createBooking(ours(at(5, 30), at(6)));
      const results = await Promise.all([
        store.transition(booking.id, "awaiting_approval", "cancelled", cancelEvent()),
        store.transition(booking.id, "awaiting_approval", "no_show", { actor: "owner", type: "no_show", data: {} }),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const events = await store.listEvents(booking.id);
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe(results[0] ? "cancelled" : "no_show");
    });

    it("getBusyIntervals() returns holds (with their deadline), awaiting_deposit and confirmed bookings and blocked times, not final ones", async () => {
      const statuses = ["awaiting_deposit", "expired", "completed", "no_show", "cancelled"];
      // 18:00, 18:30, … one per status, inserted directly (the store only creates holds). The one awaiting
      // its deposit lapses at PAY_UNTIL (bookings_deposit_has_deadline).
      const rows = await sql<{ id: string }[]>`
        insert into bookings (shop_slug, service_id, staff_id, during, status, customer_name, agent_name, deposit_cents, pay_by)
        select ${shop}, 'trim', ${staffId},
               tstzrange(${at(18).toISOString()}::timestamptz + (s.n - 1) * interval '30 minutes',
                         ${at(18, 30).toISOString()}::timestamptz + (s.n - 1) * interval '30 minutes', '[)'),
               s.status, 'Postgres Test', 'vitest', 0,
               case when s.status = 'awaiting_deposit' then ${PAY_UNTIL.toISOString()}::timestamptz end
        from unnest(${statuses}::text[]) with ordinality as s (status, n)
        returning id::text as id
      `;
      expect(rows).toHaveLength(5);
      const hold = await store.createBooking(ours(at(21), at(21, 30)));
      const [confirmed] = await sql<{ id: string }[]>`
        insert into bookings (shop_slug, service_id, staff_id, during, status, customer_name, agent_name, deposit_cents)
        values (${shop}, 'trim', ${staffId}, tstzrange(${at(21, 30).toISOString()}::timestamptz, ${at(22).toISOString()}::timestamptz, '[)'),
                'confirmed', 'Postgres Test', 'vitest', 0)
        returning id::text as id
      `;
      const block = await store.createBlock(shop, { staffId, start: at(20), end: at(21), reason: "Dentist" });
      expect(block).not.toBeNull();

      const busy = await store.getBusyIntervals(shop, { start: at(17), end: at(22) });
      expect(busy.map((b) => [b.kind, b.start.getTime(), b.end.getTime(), b.heldUntil?.getTime()])).toEqual([
        ["booking", at(18).getTime(), at(18, 30).getTime(), PAY_UNTIL.getTime()], // awaiting_deposit: until pay_by
        ["block", at(20).getTime(), at(21).getTime(), undefined],
        ["booking", at(21).getTime(), at(21, 30).getTime(), HELD_UNTIL.getTime()], // awaiting_approval: a hold
        ["booking", at(21, 30).getTime(), at(22).getTime(), undefined], // confirmed
      ]);
      expect(busy[1].reason).toBe(`block ${block!.id}`);
      expect(busy[2].reason).toBe(`booking ${hold.id}`);
      expect(busy[3].reason).toBe(`booking ${confirmed.id}`);
      expect(busy.every((b) => b.staffId === staffId)).toBe(true);

      // Blocks of another shop's staff don't count.
      expect((await store.getBusyIntervals("harts", { start: at(20), end: at(21) })).filter((b) => b.kind === "block")).toEqual([]);
      await store.deleteBlock(shop, block!.id);
    });

    // ---- Consent (Ring 1b): lazy expiry and approvals (the throwaway shop, on the next day) ----

    /** A hold in the throwaway shop at `h`:00 the next day (30 minutes), lapsing at `approveBy`. */
    const holdAt = (h: number, approveBy: Date, extra: Partial<NewBooking> = {}) =>
      store.createBooking({ ...ours(at(24 + h), at(24 + h, 30)), approveBy, ...extra });
    const statusOf = async (id: string) => (await store.getBooking(id))?.status;
    const eventsOf = async (id: string) => (await store.listEvents(id)).map((e) => [e.type, e.actor]);
    /** 6 digits of this run's own, in the phone numbers this file stores. */
    const PHONE_PREFIX = String(100000 + Math.floor(Math.random() * 900000));
    /** A distinct E.164 number for this run, ending in 4321, e.g. phoneOf(5) = "+1<prefix>054321". */
    const phoneOf = (n: number) => `+1${PHONE_PREFIX}${String(n).padStart(2, "0")}4321`;
    const DEADLINE = at(30);

    it("refreshBooking() expires a lapsed hold (one expired event by the system) and reads it, in one statement", async () => {
      const hold = await holdAt(1, DEADLINE);
      expect(await store.refreshBooking(hold.id, new Date(DEADLINE.getTime() - 1))).toEqual(hold);
      expect(await eventsOf(hold.id)).toEqual([["booked", "agent"]]);

      const expired = await store.refreshBooking(hold.id.toUpperCase(), DEADLINE); // the deadline itself counts
      expect(expired).toEqual({ ...hold, approval: undefined, status: "expired" });
      const events = await store.listEvents(hold.id);
      expect(events.map((e) => [e.type, e.actor])).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      expect(events[1].data).toEqual(expiredEventData(500));

      // Reading it again expires nothing more.
      expect(await store.refreshBooking(hold.id, at(40))).toEqual({ ...hold, approval: undefined, status: "expired" });
      expect(await store.listEvents(hold.id)).toHaveLength(2);
      expect(await store.refreshBooking(crypto.randomUUID(), DEADLINE)).toBeNull();
      expect(await store.refreshBooking("not-a-uuid", DEADLINE)).toBeNull();

      // The expired hold frees its time.
      await expect(store.createBooking({ ...ours(at(25), at(25, 30)), approveBy: at(40) })).resolves.toMatchObject({
        status: "awaiting_approval",
      });
    });

    it("refreshBooking() leaves a booking that isn't a hold alone, whatever the time", async () => {
      const hold = await holdAt(2, DEADLINE);
      await store.transition(hold.id, "awaiting_approval", "confirmed", { actor: "customer", type: "approved", data: {} });
      expect((await store.refreshBooking(hold.id, at(40)))?.status).toBe("confirmed");
      expect(await eventsOf(hold.id)).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);
    });

    it("expireStaleHolds() expires only this shop's lapsed holds in the range, each once even when two run together", async () => {
      const lapsed = await holdAt(3, DEADLINE);
      const live = await holdAt(4, new Date(DEADLINE.getTime() + 1));
      const outside = await holdAt(8, DEADLINE);
      const range = { start: at(24 + 3), end: at(24 + 5) };

      const counts = await Promise.all([
        store.expireStaleHolds(shop, range, DEADLINE),
        store.expireStaleHolds(shop, range, DEADLINE),
      ]);
      expect(counts.sort()).toEqual([0, 1]);
      expect(await statusOf(lapsed.id)).toBe("expired");
      expect(await eventsOf(lapsed.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      expect(await statusOf(live.id)).toBe("awaiting_approval");
      expect(await statusOf(outside.id)).toBe("awaiting_approval");

      // Another shop's call doesn't touch these.
      await store.expireStaleHolds("harts", { start: at(24 + 8), end: at(24 + 9) }, at(40));
      expect(await statusOf(outside.id)).toBe("awaiting_approval");
      expect(await store.expireStaleHolds(shop, { start: at(24 + 8), end: at(24 + 9) }, DEADLINE)).toBe(1);
    });

    it("findApproval() finds a hold's approval by its token, with the deadline and the mandate", async () => {
      const token = newApprovalToken();
      const mandate = { depositCapCents: 500 };
      const hold = await holdAt(5, DEADLINE, { approvalToken: token, mandate });
      expect(await store.findApproval(token)).toEqual({ bookingId: hold.id, decision: null, approveBy: DEADLINE, mandate });
      expect(await store.findApproval(newApprovalToken())).toBeNull();
    });

    it("answerApproval(): approve confirms, stores the phone and marks the approval decided, in one transaction", async () => {
      const hold = await holdAt(10, DEADLINE);
      const now = at(28);
      const phone = phoneOf(5);
      const approve = (bookingId: string, withPhone: string | null) =>
        store.answerApproval({
          bookingId,
          decision: "approved",
          nextStatus: "confirmed",
          now,
          phone: withPhone,
          event: { actor: "customer", type: "approved", data: {} },
        });

      const result = await approve(hold.id, phone);
      expect(result).toEqual({
        ok: true,
        booking: { ...hold, approval: undefined, status: "confirmed", customer: customerOf("Postgres Test", true, phone) },
      });
      const [row] = await sql<{ customer_phone: string | null; decision: string; decided_at: Date }[]>`
        select b.customer_phone, a.decision, a.decided_at
        from bookings b join approvals a on a.booking_id = b.id
        where b.id = ${hold.id}::uuid
      `;
      expect(row).toEqual({ customer_phone: phone, decision: "approved", decided_at: now });
      expect(await eventsOf(hold.id)).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);
      // Every read shows the approved customer, from the approval row.
      expect(await store.getBooking(hold.id)).toEqual(result.ok && result.booking);
      expect((await store.listBookings(shop, { start: at(34), end: at(34, 30) })).map((b) => b.customer)).toEqual([
        customerOf("Postgres Test", true, phone),
      ]);

      // Answering again: refused, nothing written.
      expect(await approve(hold.id, phoneOf(7))).toEqual({ ok: false, reason: "not_pending" });
      expect(await store.listEvents(hold.id)).toHaveLength(2);
      expect((await sql<{ customer_phone: string }[]>`select customer_phone from bookings where id = ${hold.id}::uuid`)[0].customer_phone).toBe(phone);

      // Without a phone: still approved (via the link), no customer.phone, nothing stored.
      const second = await holdAt(11, DEADLINE);
      const bare = await approve(second.id, null);
      expect(bare).toEqual({ ok: true, booking: { ...second, approval: undefined, status: "confirmed", customer: customerOf("Postgres Test", true) } });
      expect((await sql<{ customer_phone: string | null }[]>`select customer_phone from bookings where id = ${second.id}::uuid`)[0].customer_phone).toBeNull();
    });

    it("bookings.customer_phone accepts only E.164", async () => {
      const hold = await holdAt(14, DEADLINE);
      await expect(sql`update bookings set customer_phone = '555-0123' where id = ${hold.id}::uuid`).rejects.toMatchObject({ code: "23514" });
      await sql`update bookings set customer_phone = ${phoneOf(8)} where id = ${hold.id}::uuid`;
      expect((await store.getBooking(hold.id))?.customer).toEqual(customerOf("Postgres Test", false, phoneOf(8)));
    });

    it("answerApproval(): a lapsed hold or an answered approval is not_pending, and nothing is written", async () => {
      const lapsed = await holdAt(12, DEADLINE);
      const result = await store.answerApproval({
        bookingId: lapsed.id,
        decision: "approved",
        nextStatus: "confirmed",
        now: DEADLINE,
        phone: phoneOf(6),
        event: { actor: "customer", type: "approved", data: {} },
      });
      expect(result).toEqual({ ok: false, reason: "not_pending" });
      expect(await store.findApproval((await sql<{ token: string }[]>`select token from approvals where booking_id = ${lapsed.id}::uuid`)[0].token)).toMatchObject({ decision: null });
      expect(await statusOf(lapsed.id)).toBe("awaiting_approval");
      expect((await sql<{ customer_phone: string | null }[]>`select customer_phone from bookings where id = ${lapsed.id}::uuid`)[0].customer_phone).toBeNull();
      expect(await eventsOf(lapsed.id)).toEqual([["booked", "agent"]]);

      // Decline: cancelled by the customer; a second answer is not_pending.
      const hold = await holdAt(13, DEADLINE);
      const decline = () =>
        store.answerApproval({
          bookingId: hold.id,
          decision: "declined",
          nextStatus: "cancelled",
          now: at(28),
          event: { actor: "customer", type: "declined", data: { from: "awaiting_approval", to: "cancelled" } },
        });
      expect(await decline()).toEqual({ ok: true, booking: { ...hold, approval: undefined, status: "cancelled" } });
      const [row] = await sql<{ cancelled_by: string; cancelled_at: Date | null; decision: string }[]>`
        select b.cancelled_by, b.cancelled_at, a.decision from bookings b join approvals a on a.booking_id = b.id where b.id = ${hold.id}::uuid
      `;
      expect(row).toMatchObject({ cancelled_by: "customer", cancelled_at: expect.any(Date), decision: "declined" });
      expect(await decline()).toEqual({ ok: false, reason: "not_pending" });
      expect(await eventsOf(hold.id)).toEqual([
        ["booked", "agent"],
        ["declined", "customer"],
      ]);
    });

    // ---- Owner writes (the throwaway shop) ----

    it("round-trips policies: none, insert, update", async () => {
      expect(await store.getPolicies(shop)).toBeNull();
      const first: Policies = {
        leadTimeMin: 60,
        horizonDays: 14,
        depositHorizonDays: 3,
        cancelWindowHours: 12,
        paused: false,
        phone: null,
        depositRule: "",
        lateCancelRule: "",
        noShowRule: "",
        ownerEmail: null,
      };
      expect(await store.savePolicies(shop, first)).toEqual(first);
      const second: Policies = {
        ...first,
        paused: true,
        phone: "+1 555-0100",
        noShowRule: "We keep the deposit.",
        ownerEmail: "dana@example.com",
      };
      expect(await store.savePolicies(shop, second)).toEqual(second);
      expect(await store.getPolicies(shop)).toEqual(second);
    });

    it("savePolicies on a shop without a row stores the column defaults plus the patch, even when two race", async () => {
      await sql`delete from policies where shop_slug = ${shop}`;
      // The column defaults must match DEFAULT_POLICIES.
      expect(await store.savePolicies(shop, { phone: "+1 555-0100" })).toEqual({ ...DEFAULT_POLICIES, phone: "+1 555-0100" });

      await sql`delete from policies where shop_slug = ${shop}`;
      await Promise.all([store.savePolicies(shop, { paused: true }), store.savePolicies(shop, { leadTimeMin: 60 })]);
      expect(await store.getPolicies(shop)).toEqual({ ...DEFAULT_POLICIES, paused: true, leadTimeMin: 60 });
    });

    it("savePolicies keeps fields that are undefined in the patch, and phone: null clears the phone", async () => {
      await store.savePolicies(shop, { phone: "+1 555-0100", noShowRule: "" });
      const before = (await store.getPolicies(shop))!;
      expect(await store.savePolicies(shop, { paused: undefined, phone: undefined, noShowRule: "n" })).toEqual({
        ...before,
        noShowRule: "n",
      });
      expect(await store.savePolicies(shop, { phone: null })).toEqual({ ...before, noShowRule: "n", phone: null });
      expect(await store.getPolicies(shop)).toEqual({ ...before, noShowRule: "n", phone: null });
      // ownerEmail likewise: kept when absent, cleared by null.
      expect((await store.savePolicies(shop, { ownerEmail: "owner@example.com" })).ownerEmail).toBe("owner@example.com");
      expect((await store.savePolicies(shop, { paused: true })).ownerEmail).toBe("owner@example.com");
      expect((await store.savePolicies(shop, { ownerEmail: null })).ownerEmail).toBeNull();
    });

    it("savePolicies: concurrent patches of different fields both take effect (the row is locked from read to write)", async () => {
      await store.savePolicies(shop, { paused: false, leadTimeMin: 120 });
      const before = (await store.getPolicies(shop))!;
      // Hold the row's lock until both saves are queued behind it. Without a lock between each save's
      // read and its write, both would read this same row and the second write would undo the first.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holderPid!: (pid: number) => void;
      const pid = new Promise<number>((resolve) => (holderPid = resolve));
      const holder = sql.begin(async (tx) => {
        const [row] = await tx<{ pid: number }[]>`
          select pg_backend_pid() as pid from policies where shop_slug = ${shop} for update
        `;
        holderPid(row.pid);
        await released;
      });
      const holding = await pid;
      const saves = Promise.all([store.savePolicies(shop, { paused: true }), store.savePolicies(shop, { leadTimeMin: 60 })]);
      // Wait until both are blocked, directly or behind each other, by the holder.
      for (let waited = 0; ; waited += 20) {
        const [{ n }] = await sql<{ n: number }[]>`
          with recursive waiting (pid) as (
            select pid from pg_stat_activity where ${holding}::int = any(pg_blocking_pids(pid))
            union
            select a.pid from pg_stat_activity a join waiting w on w.pid = any(pg_blocking_pids(a.pid))
          )
          select count(*)::int as n from waiting
        `;
        if (n >= 2) break;
        if (waited > 5000) throw new Error(`Only ${n} of the two saves queued behind the lock.`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await holder;
      await saves;
      expect(await store.getPolicies(shop)).toEqual({ ...before, paused: true, leadTimeMin: 60 });
    });

    it("creates services at the end of the list and patches only the given fields", async () => {
      const shave = { id: "shave", name: "Shave", durationMin: 20, priceCents: 2000, depositCents: 0 };
      const color = { id: "color", name: "Color", durationMin: 90, priceCents: 9000, depositCents: 2000 };
      expect(await store.createService(shop, shave)).toEqual(shave);
      expect(await store.createService(shop, color)).toEqual(color);
      expect((await store.listServices(shop)).map((s) => s.id)).toEqual(["trim", "shave", "color"]);

      const err = await store.createService(shop, { ...shave, name: "Again" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DuplicateServiceError);
      expect((err as DuplicateServiceError).serviceId).toBe("shave");

      expect(await store.updateService(shop, "shave", { priceCents: 2500 })).toEqual({ ...shave, priceCents: 2500 });
      expect(await store.updateService(shop, "shave", { name: "Hot shave", durationMin: 25 })).toEqual({
        ...shave,
        name: "Hot shave",
        durationMin: 25,
        priceCents: 2500,
      });
      expect(await store.updateService(shop, "perm", { priceCents: 1 })).toBeNull();
      expect(await store.updateService(shop, "haircut", { priceCents: 1 })).toBeNull(); // Hart's service
    });

    it("refuses a deposit larger than the price (services_deposit_le_price), even from two concurrent edits", async () => {
      const race = { id: "deposit-race", name: "Deposit race", durationMin: 30, priceCents: 3500, depositCents: 1000 };
      expect(await store.createService(shop, race)).toEqual(race);
      // Each patch is fine against the stored row; together they'd leave a 3000 deposit on a 2000 price.
      const results = await Promise.allSettled([
        store.updateService(shop, race.id, { depositCents: 3000 }),
        store.updateService(shop, race.id, { priceCents: 2000 }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(DepositExceedsPriceError);
      expect((reason as DepositExceedsPriceError).serviceId).toBe(race.id);
      const stored = (await store.listServices(shop)).find((s) => s.id === race.id)!;
      expect(stored.depositCents).toBeLessThanOrEqual(stored.priceCents);
      expect(stored).toEqual((fulfilled[0] as PromiseFulfilledResult<unknown>).value);

      const err = await store
        .createService(shop, { id: "too-much", name: "Too much", durationMin: 20, priceCents: 2000, depositCents: 2001 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DepositExceedsPriceError);
      expect((err as DepositExceedsPriceError).serviceId).toBe("too-much");
      expect((await store.listServices(shop)).map((s) => s.id)).not.toContain("too-much");
    });

    it("replaces a staff member's whole week, and refuses staff outside the shop", async () => {
      expect(await store.getStaffHours(shop)).toEqual([{ staffId, staffName: "Sam", weekly: [] }]);
      const week = [
        { weekday: 3 as const, open: "13:00", close: "17:00" },
        { weekday: 1 as const, open: "09:00", close: "12:00" },
        { weekday: 3 as const, open: "08:00", close: "12:00" },
      ];
      expect(await store.replaceWeeklyHours(shop, staffId, week)).toBe(true);
      expect((await store.getStaffHours(shop))[0].weekly).toEqual([
        { weekday: 1, open: "09:00", close: "12:00" },
        { weekday: 3, open: "08:00", close: "12:00" },
        { weekday: 3, open: "13:00", close: "17:00" },
      ]);
      expect(await store.replaceWeeklyHours(shop, staffId, week.slice(0, 1))).toBe(true);
      expect((await store.getStaffHours(shop))[0].weekly).toEqual([{ weekday: 3, open: "13:00", close: "17:00" }]);
      expect(await store.replaceWeeklyHours(shop, "dana", week)).toBe(false); // Dana works at Hart's
      expect(await store.replaceWeeklyHours(shop, staffId, [])).toBe(true);
      expect((await store.getStaffHours(shop))[0].weekly).toEqual([]);
    });

    it("creates, lists and deletes blocked times, scoped to the shop", async () => {
      const range = { start: at(11), end: at(14) };
      const later = await store.createBlock(shop, { staffId, start: at(13), end: at(14), reason: "Holiday" });
      const earlier = await store.createBlock(shop, { staffId, start: at(11), end: at(12), reason: "" });
      expect(later).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        staffId,
        start: DateTime.fromJSDate(at(13), { zone: "America/New_York" }).toISO({ suppressMilliseconds: true }),
        end: DateTime.fromJSDate(at(14), { zone: "America/New_York" }).toISO({ suppressMilliseconds: true }),
        reason: "Holiday",
      });
      expect(await store.listBlocks(shop, range)).toEqual([earlier, later]);
      expect(await store.listBlocks(shop, { start: at(12), end: at(13) })).toEqual([]); // half-open
      expect(await store.listBlocks("harts", range)).toEqual([]);
      expect(await store.createBlock(shop, { staffId: "dana", start: at(11), end: at(12), reason: "" })).toBeNull();

      expect(await store.deleteBlock("harts", later!.id)).toBeNull();
      expect(await store.deleteBlock(shop, "not-a-uuid")).toBeNull();
      expect(await store.deleteBlock(shop, later!.id)).toEqual(later);
      expect(await store.deleteBlock(shop, later!.id)).toBeNull();
      expect(await store.deleteBlock(shop, earlier!.id)).toEqual(earlier);
      expect(await store.listBlocks(shop, DAY)).toEqual([]);
    });

    it("records PAP agents (first and last seen), stores agent_client_id on bookings, and lists agents with counts", async () => {
      const first = `https://vitest-${run}.example/first.json`;
      const second = `https://vitest-${run}.example/second.json`;
      // Other tests here book at the throwaway shop too, unconfirmed.
      const before = (await store.listAgents(shop)).unconfirmedBookings;
      try {
        await store.recordAgent({ clientId: first, name: "First" });
        await store.recordAgent({ clientId: second, name: "Second" });
        await sql`update agents set first_seen = now() - interval '1 hour', last_seen = now() - interval '1 hour' where client_id = ${first}`;
        await store.recordAgent({ clientId: first, name: "First, renamed" });

        const confirmed = await store.createBooking({ ...ours(at(9), at(9, 30)), agentName: "First, renamed", agentClientId: first });
        expect(confirmed.agent).toEqual({ name: "First, renamed", confirmed: true, clientId: first });
        expect((await store.listEvents(confirmed.id))[0].data).toEqual({
          status: "awaiting_approval",
          agentName: "First, renamed",
          agentClientId: first,
        });
        const unconfirmed = await store.createBooking(ours(at(10), at(10, 30)));
        expect(unconfirmed.agent).toEqual({ name: "vitest", confirmed: false });
        expect((await store.getBooking(confirmed.id))?.agent.confirmed).toBe(true);

        const { agents, unconfirmedBookings } = await store.listAgents(shop);
        const mine = agents.filter((a) => a.clientId.startsWith(`https://vitest-${run}.`));
        // first was seen again just now, so it comes before second; its first_seen stayed an hour back.
        expect(mine.map((a) => [a.clientId, a.name, a.bookings])).toEqual([
          [first, "First, renamed", 1],
          [second, "Second", 0],
        ]);
        expect(mine[0].firstSeen.getTime()).toBeLessThan(mine[0].lastSeen.getTime() - 3_000_000);
        expect(mine[0].lastBookedAt?.getTime()).toBe(Date.parse(confirmed.createdAt));
        expect(mine[1].lastBookedAt).toBeNull();
        expect(unconfirmedBookings).toBe(before + 1);
      } finally {
        await sql`delete from agents where client_id = any(${[first, second]}::text[])`;
      }
    });
  });
}
