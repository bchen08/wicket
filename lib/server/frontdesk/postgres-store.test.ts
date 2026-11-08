import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Policies } from "../../types/frontdesk";
import { fixedClock } from "../clock";
import { sha256Hex } from "../consent/crypto";
import {
  expiredEventData,
  SlotTakenError,
  type BookingStore,
  type ChallengeRecord,
  type IdempotencyScope,
  type NewBooking,
  type NewBookingEvent,
} from "./booking-store";
import { DepositExceedsPriceError, DuplicateServiceError } from "./catalog";
import { FrontDeskError } from "./errors";
import { SEED } from "./memory-store";
import { DEFAULT_POLICIES } from "./policies";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book } from "./service";
import { holdFields, withConsent } from "./test-support";

// Runs against a real Postgres only when DATABASE_URL_TEST points at a database with
// supabase/migrations/0001_skeleton.sql, 0002_rules.sql, 0003_consent.sql and supabase/seed.sql applied
// (see docs/database.md).
// Use a scratch database. Other test files may share it, so this file only adds rows of its own and
// deletes them afterwards: bookings in 2099, idempotency keys with a random prefix, and a throwaway
// shop (with its own staff member and service) for the lifecycle, idempotency and owner-write tests,
// so Hart's seeded data is only read, never changed.
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
    const bookKeys: string[] = [];
    const run = Math.random().toString(16).slice(2, 10);
    // A random day in 2099, so parallel or repeated runs don't collide with each other or real data.
    const day = new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 300) * 86_400_000);
    const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000);
    /** Every hold createBooking makes in this file lapses here (two days later) unless a test says otherwise. */
    const HELD_UNTIL = at(48);
    const input = (start: Date, end: Date, serviceId = "haircut"): NewBooking => ({
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
    const keyPrefix = `vitest-${run}-`;
    const key = (name: string) => `${keyPrefix}${name}`;
    const scope = (name: string, requestHash = "hash-a"): IdempotencyScope => ({ key: key(name), tool: "book", requestHash });
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
    const keyRows = (name: string) => sql`select key from idempotency_keys where key = ${key(name)} and tool = 'book'`;

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Shop', 'America/New_York')`;
      await sql`insert into staff (id, shop_slug, name) values (${staffId}, ${shop}, 'Sam')`;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 500, 1)
      `;
    });

    afterAll(async () => {
      // Customers aren't cascaded from bookings: delete the ones this file's approvals made.
      await sql`
        delete from customers where id in (
          select customer_id from bookings where customer_id is not null and (shop_slug = ${shop} or id = any(${created}::uuid[]))
        )
      `;
      if (created.length > 0) {
        await sql`delete from bookings where id = any(${created}::uuid[])`;
      }
      if (bookKeys.length > 0) {
        await sql`delete from idempotency_keys where key = any(${bookKeys}::text[])`;
      }
      await sql`delete from idempotency_keys where starts_with(key, ${keyPrefix})`;
      await sql`delete from bookings where shop_slug = ${shop}`; // events cascade
      await sql`delete from shops where slug = ${shop}`;
      await closePostgresClients();
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
      const deps = withConsent({
        catalog: store,
        store,
        clock: fixedClock(saturday.minus({ days: 1 }).toJSDate()),
        notifier: { alertOwner: async () => {} },
      });
      const [keyA, keyB] = [crypto.randomUUID(), crypto.randomUUID()];
      bookKeys.push(keyA, keyB);
      const results = await Promise.allSettled([
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent A's customer", idempotency_key: keyA }, "vitest A"),
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent B's customer", idempotency_key: keyB }, "vitest B"),
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
        customer: { displayName: "Postgres Test", verified: false },
      });
      expect(booking).not.toHaveProperty("approval"); // book adds the link; the store never knows the token
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
      const [row] = await sql<{ approve_by: Date; mandate: unknown; customer_id: string | null; token_hash: string; decision: string | null }[]>`
        select b.approve_by, b.mandate, b.customer_id, a.token_hash, a.decision
        from bookings b join approvals a on a.booking_id = b.id where b.id = ${booking.id}::uuid
      `;
      expect(row).toEqual({
        approve_by: HELD_UNTIL,
        mandate: null,
        customer_id: null,
        token_hash: fields.approvalTokenHash,
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
      expect(cancelled).toEqual({ ...booking, status: "cancelled" });

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
      // 18:00, 18:30, … one per status, inserted directly (the store only creates holds).
      const rows = await sql<{ id: string }[]>`
        insert into bookings (shop_slug, service_id, staff_id, during, status, customer_name, agent_name, deposit_cents)
        select ${shop}, 'trim', ${staffId},
               tstzrange(${at(18).toISOString()}::timestamptz + (s.n - 1) * interval '30 minutes',
                         ${at(18, 30).toISOString()}::timestamptz + (s.n - 1) * interval '30 minutes', '[)'),
               s.status, 'Postgres Test', 'vitest', 0
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
        ["booking", at(18).getTime(), at(18, 30).getTime(), undefined], // awaiting_deposit
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

    // ---- Idempotency ----

    /** An action that books `start` for 30 minutes in the throwaway shop and counts its runs. */
    function booking(start: Date) {
      const counter = {
        runs: 0,
        action: async (s: BookingStore) => {
          counter.runs++;
          return { booking: await s.createBooking(ours(start, new Date(start.getTime() + 30 * 60_000))) };
        },
      };
      return counter;
    }

    it("idempotent() runs the action once and replays its result for the same key and arguments", async () => {
      const c = booking(at(7));
      const first = await store.idempotent(scope("replay"), c.action);
      expect(first.replayed).toBe(false);
      const second = await store.idempotent(scope("replay"), c.action);
      expect(second).toEqual({ result: first.result, replayed: true });
      expect(c.runs).toBe(1);
      const listed = await store.listBookings(shop, { start: at(7), end: at(7, 30) });
      expect(listed.map((b) => b.id)).toEqual([first.result.booking.id]);
      expect(await store.listEvents(first.result.booking.id)).toHaveLength(1);
    });

    it("idempotent() throws idempotency_conflict for the same key with different arguments", async () => {
      let runs = 0;
      await store.idempotent(scope("conflict", "hash-a"), async () => ++runs);
      const err = await store.idempotent(scope("conflict", "hash-b"), async () => ++runs).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FrontDeskError);
      expect(err).toMatchObject({
        code: "idempotency_conflict",
        details: { idempotency_key: key("conflict"), tool: "book" },
      });
      expect(runs).toBe(1);
    });

    it("idempotent() rolls back the action's writes and the key when the action throws", async () => {
      await expect(
        store.idempotent(scope("rollback"), async (s) => {
          await s.createBooking(ours(at(8), at(8, 30)));
          throw new Error("after the write");
        }),
      ).rejects.toThrow("after the write");
      expect(await store.listBookings(shop, { start: at(8), end: at(8, 30) })).toEqual([]);
      expect(await keyRows("rollback")).toHaveLength(0);

      // The next call runs (even with other arguments).
      const next = await store.idempotent(scope("rollback", "hash-b"), async () => "ran");
      expect(next).toEqual({ result: "ran", replayed: false });
    });

    it("idempotent(): concurrent calls with the same key make one booking and get the same result", async () => {
      const c = booking(at(9));
      const [a, b] = await Promise.all([
        store.idempotent(scope("concurrent"), c.action),
        store.idempotent(scope("concurrent"), c.action),
      ]);
      expect(c.runs).toBe(1);
      expect(a.result).toEqual(b.result);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(await store.listBookings(shop, { start: at(9), end: at(9, 30) })).toHaveLength(1);
    });

    it("idempotent(): a key older than 24 hours may be reused", async () => {
      let runs = 0;
      await store.idempotent(scope("ttl", "hash-a"), async () => ++runs);
      await sql`update idempotency_keys set created_at = now() - interval '24 hours 1 second' where key = ${key("ttl")}`;
      expect(await store.idempotent(scope("ttl", "hash-b"), async () => ++runs)).toEqual({ result: 2, replayed: false });
      expect(await store.idempotent(scope("ttl", "hash-b"), async () => ++runs)).toEqual({ result: 2, replayed: true });
    });

    it("idempotent(): a slot_taken inside the action rolls back only that insert (savepoint)", async () => {
      const taken = await store.createBooking(ours(at(10), at(10, 30)));
      const { result } = await store.idempotent(scope("savepoint"), async (s) => {
        await expect(s.createBooking(ours(at(10), at(10, 30)))).rejects.toBeInstanceOf(SlotTakenError);
        // The transaction is still usable.
        return s.createBooking(ours(at(10, 30), at(11)));
      });
      expect((await store.listBookings(shop, { start: at(10), end: at(11) })).map((b) => b.id)).toEqual([taken.id, result.id]);
      expect(await keyRows("savepoint")).toHaveLength(1);
    });

    it("idempotent() can't be nested", async () => {
      await expect(
        store.idempotent(scope("outer"), (s) => s.idempotent(scope("inner"), async () => 1)),
      ).rejects.toThrow(/can't be nested/);
      expect(await keyRows("outer")).toHaveLength(0);
    });

    // ---- Consent (Ring 1b): lazy expiry, approvals, codes (the throwaway shop, on the next day) ----

    /** A hold in the throwaway shop at `h`:00 the next day (30 minutes), lapsing at `approveBy`. */
    const holdAt = (h: number, approveBy: Date, extra: Partial<NewBooking> = {}) =>
      store.createBooking({ ...ours(at(24 + h), at(24 + h, 30)), approveBy, ...extra });
    const statusOf = async (id: string) => (await store.getBooking(id))?.status;
    const eventsOf = async (id: string) => (await store.listEvents(id)).map((e) => [e.type, e.actor]);
    /** 6 digits of this run's own, so its phone numbers (and customers, and send limits) never meet another run's. */
    const PHONE_PREFIX = String(100000 + Math.floor(Math.random() * 900000));
    /** A distinct E.164 number for this run, ending in 4321, e.g. phoneOf(5) = "+1<prefix>054321". */
    const phoneOf = (n: number) => `+1${PHONE_PREFIX}${String(n).padStart(2, "0")}4321`;
    const DEADLINE = at(30);
    const LIMITS = { perPhone: 3, perBooking: 10, windowMs: 60 * 60 * 1000 };
    const challenge = (bookingId: string, phone: string, now: Date, limits = LIMITS) =>
      store.createChallenge({
        bookingId,
        phone,
        codeHash: sha256Hex(`code-${Math.random()}`),
        expiresAt: new Date(now.getTime() + 10 * 60_000),
        now,
        limits,
      });

    it("refreshBooking() expires a lapsed hold (one expired event by the system) and reads it, in one statement", async () => {
      const hold = await holdAt(1, DEADLINE);
      expect(await store.refreshBooking(hold.id, new Date(DEADLINE.getTime() - 1))).toEqual(hold);
      expect(await eventsOf(hold.id)).toEqual([["booked", "agent"]]);

      const expired = await store.refreshBooking(hold.id.toUpperCase(), DEADLINE); // the deadline itself counts
      expect(expired).toEqual({ ...hold, status: "expired" });
      const events = await store.listEvents(hold.id);
      expect(events.map((e) => [e.type, e.actor])).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      expect(events[1].data).toEqual(expiredEventData(500));

      // Reading it again expires nothing more.
      expect(await store.refreshBooking(hold.id, at(40))).toEqual({ ...hold, status: "expired" });
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

    it("findApproval() finds a hold's approval by its token hash, with the deadline and the mandate", async () => {
      const tokenHash = sha256Hex(`token-${run}-find`);
      const mandate = { depositCapCents: 500 };
      const hold = await holdAt(5, DEADLINE, { approvalTokenHash: tokenHash, mandate });
      expect(await store.findApproval(tokenHash)).toEqual({ bookingId: hold.id, decision: null, approveBy: DEADLINE, mandate });
      expect(await store.findApproval(sha256Hex(`token-${run}-nobody`))).toBeNull();
    });

    it("createChallenge() enforces the per-booking and per-phone limits over a sliding window, with retryAfterMs", async () => {
      const a = await holdAt(6, DEADLINE);
      const b = await holdAt(7, DEADLINE);
      const phone = phoneOf(1);
      const t0 = at(28);
      const minute = 60_000;
      for (let i = 0; i < 3; i++) {
        const sent = await challenge(i < 2 ? a.id : b.id, phone, new Date(t0.getTime() + i * minute));
        expect(sent.ok).toBe(true);
      }
      // A 4th code to the same phone within the hour, for either booking → limited until the 1st ages out.
      const now = new Date(t0.getTime() + 10 * minute);
      expect(await challenge(b.id, phone, now)).toEqual({ ok: false, limit: "phone", retryAfterMs: 50 * minute });
      // Exactly an hour after the first send, it no longer counts.
      expect((await challenge(b.id, phone, new Date(t0.getTime() + 60 * minute))).ok).toBe(true);

      // Per booking: at most 2 here, whatever the phone.
      const tight = { ...LIMITS, perBooking: 2 };
      expect(await challenge(a.id, phoneOf(2), now, tight)).toEqual({ ok: false, limit: "booking", retryAfterMs: 50 * minute });

      const latest = await store.latestChallenge(b.id);
      expect(latest).toMatchObject({ bookingId: b.id, phone, attempts: 0, consumedAt: null });
      expect(latest!.createdAt).toEqual(new Date(t0.getTime() + 60 * minute));
      expect(await store.latestChallenge(crypto.randomUUID())).toBeNull();
      expect(await store.latestChallenge("not-a-uuid")).toBeNull();
    });

    it("recordCodeAttempt() counts attempts only while the code is usable", async () => {
      const hold = await holdAt(9, DEADLINE);
      const now = at(28);
      const sent = await challenge(hold.id, phoneOf(3), now);
      if (!sent.ok) throw new Error("expected a challenge");
      const id = sent.challenge.id;
      for (let n = 1; n <= 5; n++) expect(await store.recordCodeAttempt(id, now, 5)).toBe(n);
      expect(await store.recordCodeAttempt(id, now, 5)).toBeNull();
      const [row] = await sql<{ attempts: number }[]>`select attempts from otp_challenges where id = ${id}::bigint`;
      expect(row.attempts).toBe(5);

      const fresh = await challenge(hold.id, phoneOf(4), now);
      if (!fresh.ok) throw new Error("expected a challenge");
      expect(await store.recordCodeAttempt(fresh.challenge.id, fresh.challenge.expiresAt, 5)).toBeNull(); // expired
      expect(await store.recordCodeAttempt("not-an-id", now, 5)).toBeNull();
    });

    it("answerApproval(): approve consumes the code, upserts the customer, links it and confirms, in one transaction", async () => {
      const hold = await holdAt(10, DEADLINE);
      const now = at(28);
      const phone = phoneOf(5);
      const sent = (await challenge(hold.id, phone, now)) as Extract<Awaited<ReturnType<typeof challenge>>, { ok: true }>;
      const answer = (bookingId: string, c: ChallengeRecord, displayName = "Postgres Test") =>
        store.answerApproval({
          bookingId,
          decision: "approved",
          nextStatus: "confirmed",
          now,
          challengeId: c.id,
          customer: { phone, displayName },
          event: { actor: "customer", type: "approved", data: { phoneLast4: "4321" } },
        });

      const result = await answer(hold.id, sent.challenge);
      expect(result).toEqual({
        ok: true,
        booking: { ...hold, status: "confirmed", customer: { displayName: "Postgres Test", verified: true, phoneLast4: "4321" } },
      });
      const [row] = await sql<{ customer_id: string; phone: string; display_name: string; consumed_at: Date; decision: string; decided_at: Date }[]>`
        select c.id::text as customer_id, c.phone, c.display_name, o.consumed_at, a.decision, a.decided_at
        from bookings b
        join customers c on c.id = b.customer_id
        join otp_challenges o on o.booking_id = b.id
        join approvals a on a.booking_id = b.id
        where b.id = ${hold.id}::uuid
      `;
      expect(row).toMatchObject({ phone, display_name: "Postgres Test", consumed_at: now, decision: "approved", decided_at: now });
      expect(await eventsOf(hold.id)).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);

      // The same code again: refused, nothing written. (Postgres checks the approval row first, so this
      // already-answered booking reads as not_pending; a used code on a pending booking is code_used, below.)
      expect(await answer(hold.id, sent.challenge)).toMatchObject({ ok: false });
      expect(await store.listEvents(hold.id)).toHaveLength(2);

      // A used code on a booking still awaiting approval: code_used, and nothing written.
      const pending = await holdAt(14, DEADLINE);
      const used = (await challenge(pending.id, phone, now)) as Extract<Awaited<ReturnType<typeof challenge>>, { ok: true }>;
      await sql`update otp_challenges set consumed_at = ${now.toISOString()}::timestamptz where id = ${used.challenge.id}::bigint`;
      expect(await answer(pending.id, used.challenge)).toEqual({ ok: false, reason: "code_used" });
      expect(await statusOf(pending.id)).toBe("awaiting_approval");
      expect(await eventsOf(pending.id)).toEqual([["booked", "agent"]]);
      expect((await sql<{ decision: string | null }[]>`select decision from approvals where booking_id = ${pending.id}::uuid`)[0].decision).toBeNull();

      // The same phone approving another hold under another name: the same customer, its name updated.
      const second = await holdAt(11, DEADLINE);
      const sent2 = (await challenge(second.id, phone, now)) as Extract<Awaited<ReturnType<typeof challenge>>, { ok: true }>;
      expect((await answer(second.id, sent2.challenge, "Renamed Test")).ok).toBe(true);
      const customers = await sql<{ id: string; display_name: string }[]>`
        select id::text as id, display_name from customers where phone = ${phone}
      `;
      expect(customers).toEqual([{ id: row.customer_id, display_name: "Renamed Test" }]);
    });

    it("answerApproval(): a lapsed hold or an answered approval is not_pending, and nothing is written", async () => {
      const lapsed = await holdAt(12, DEADLINE);
      const sent = (await challenge(lapsed.id, phoneOf(6), at(28))) as Extract<Awaited<ReturnType<typeof challenge>>, { ok: true }>;
      const result = await store.answerApproval({
        bookingId: lapsed.id,
        decision: "approved",
        nextStatus: "confirmed",
        now: DEADLINE,
        challengeId: sent.challenge.id,
        customer: { phone: phoneOf(6), displayName: "Postgres Test" },
        event: { actor: "customer", type: "approved", data: {} },
      });
      expect(result).toEqual({ ok: false, reason: "not_pending" });
      expect((await store.latestChallenge(lapsed.id))?.consumedAt).toBeNull();
      expect(await store.findApproval((await sql<{ token_hash: string }[]>`select token_hash from approvals where booking_id = ${lapsed.id}::uuid`)[0].token_hash)).toMatchObject({ decision: null });
      expect(await sql`select 1 from customers where phone = ${phoneOf(6)}`).toHaveLength(0);

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
      expect(await decline()).toEqual({ ok: true, booking: { ...hold, status: "cancelled" } });
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
      };
      expect(await store.savePolicies(shop, first)).toEqual(first);
      const second: Policies = { ...first, paused: true, phone: "+1 555-0100", noShowRule: "We keep the deposit." };
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
  });
}
