import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Policies } from "../../types/frontdesk";
import { fixedClock } from "../clock";
import { SlotTakenError, type BookingStore, type IdempotencyScope, type NewBooking, type NewBookingEvent } from "./booking-store";
import { DuplicateServiceError } from "./catalog";
import { FrontDeskError } from "./errors";
import { SEED } from "./memory-store";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book, type FrontDeskDeps } from "./service";

// Runs against a real Postgres only when DATABASE_URL_TEST points at a database with
// supabase/migrations/0001_skeleton.sql, 0002_rules.sql and supabase/seed.sql applied (see docs/database.md).
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
    const input = (start: Date, end: Date, serviceId = "haircut"): NewBooking => ({
      shopSlug: "harts",
      serviceId,
      staffId: "dana",
      start,
      end,
      customerName: "Postgres Test",
      agentName: "vitest",
      depositCents: 1000,
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
    });
    const DAY = { start: at(0), end: at(24) };
    const cancelEvent = (actor: NewBookingEvent["actor"] = "agent"): NewBookingEvent => ({
      actor,
      type: "cancelled",
      data: { from: "confirmed", to: "cancelled", depositEffect: "released", depositCollected: false },
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
      expect(first).toMatchObject({ status: "confirmed", serviceName: "Haircut", depositCents: 1000, staffId: "dana" });

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
      const deps: FrontDeskDeps = {
        catalog: store,
        store,
        clock: fixedClock(saturday.minus({ days: 1 }).toJSDate()),
        notifier: { alertOwner: async () => {} },
      };
      const [keyA, keyB] = [crypto.randomUUID(), crypto.randomUUID()];
      bookKeys.push(keyA, keyB);
      const results = await Promise.allSettled([
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent A's customer", idempotency_key: keyA }, "vitest A"),
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent B's customer", idempotency_key: keyB }, "vitest B"),
      ]);
      for (const r of results) if (r.status === "fulfilled") created.push(r.value.booking.id);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(FrontDeskError);
      expect((reason as FrontDeskError).code).toBe("slot_taken");
    });

    // ---- Lifecycle (the throwaway shop) ----

    it("createBooking stores the deposit snapshot and writes a booked event in the same statement", async () => {
      const booking = await store.createBooking(ours(at(1), at(1, 30), 777));
      expect(booking).toMatchObject({ shopSlug: shop, serviceName: "Trim", depositCents: 777, status: "confirmed" });
      const events = await store.listEvents(booking.id);
      expect(events).toEqual([
        {
          id: expect.stringMatching(/^\d+$/),
          bookingId: booking.id,
          at: expect.stringMatching(/-0[45]:00$/), // New York time
          actor: "agent",
          type: "booked",
          data: { status: "confirmed", agentName: "vitest" },
        },
      ]);
      expect(await store.getBooking(booking.id)).toEqual(booking);
      expect(await store.getBooking(booking.id.toUpperCase())).toEqual(booking);
      expect(await store.getBooking(crypto.randomUUID())).toBeNull();
      expect(await store.getBooking("not-a-uuid")).toBeNull();
      expect(await store.listEvents("not-a-uuid")).toEqual([]);
    });

    it("transition() moves the status, writes its event and stamps the time, all in one statement", async () => {
      const booking = await store.createBooking(ours(at(2), at(2, 30)));
      const cancelled = await store.transition(booking.id, "confirmed", "cancelled", cancelEvent("owner"));
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
      await expect(store.createBooking(ours(at(2), at(2, 30)))).resolves.toMatchObject({ status: "confirmed" });
    });

    it("transition() stamps completed_at and no_show_at", async () => {
      const a = await store.createBooking(ours(at(3), at(3, 30)));
      const b = await store.createBooking(ours(at(3, 30), at(4)));
      await store.transition(a.id, "confirmed", "completed", { actor: "owner", type: "completed", data: {} });
      await store.transition(b.id, "confirmed", "no_show", { actor: "owner", type: "no_show", data: {} });
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
      expect(await store.transition(booking.id, "awaiting_deposit", "cancelled", cancelEvent())).toBeNull();
      expect((await store.getBooking(booking.id))?.status).toBe("confirmed");
      expect(await store.listEvents(booking.id)).toHaveLength(1);
      expect(await store.transition(crypto.randomUUID(), "confirmed", "cancelled", cancelEvent())).toBeNull();
      expect(await store.transition("not-a-uuid", "confirmed", "cancelled", cancelEvent())).toBeNull();
    });

    it("of two concurrent transitions exactly one wins, with exactly one event", async () => {
      const booking = await store.createBooking(ours(at(5, 30), at(6)));
      const results = await Promise.all([
        store.transition(booking.id, "confirmed", "cancelled", cancelEvent()),
        store.transition(booking.id, "confirmed", "no_show", { actor: "owner", type: "no_show", data: {} }),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const events = await store.listEvents(booking.id);
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe(results[0] ? "cancelled" : "no_show");
    });

    it("getBusyIntervals() returns awaiting_deposit and confirmed bookings and blocked times, not final ones", async () => {
      const statuses = ["awaiting_deposit", "expired", "completed", "no_show", "cancelled"];
      // 18:00, 18:30, … one per status, inserted directly (the store only creates confirmed bookings).
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
      const confirmed = await store.createBooking(ours(at(21), at(21, 30)));
      const block = await store.createBlock(shop, { staffId, start: at(20), end: at(21), reason: "Dentist" });
      expect(block).not.toBeNull();

      const busy = await store.getBusyIntervals(shop, { start: at(17), end: at(22) });
      expect(busy.map((b) => [b.kind, b.start.getTime(), b.end.getTime()])).toEqual([
        ["booking", at(18).getTime(), at(18, 30).getTime()], // awaiting_deposit
        ["block", at(20).getTime(), at(21).getTime()],
        ["booking", at(21).getTime(), at(21, 30).getTime()], // confirmed
      ]);
      expect(busy[1].reason).toBe(`block ${block!.id}`);
      expect(busy[2].reason).toBe(`booking ${confirmed.id}`);
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
