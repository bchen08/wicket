import { DateTime } from "luxon";
import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "../clock";
import { SlotTakenError, type NewBooking } from "./booking-store";
import { FrontDeskError } from "./errors";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book, type FrontDeskDeps } from "./service";

// Runs against a real Postgres only when DATABASE_URL_TEST points at a database with
// supabase/migrations/0001_skeleton.sql and supabase/seed.sql applied (see docs/database.md).
// Use a scratch database: the test inserts bookings far in the future and deletes them afterwards.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Postgres store", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the overlap test against a real database", () => {});
  });
} else {
  describe("Postgres store (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const created: string[] = [];
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
    });

    afterAll(async () => {
      if (created.length > 0) {
        await getPostgresClient(url)`delete from bookings where id = any(${created}::uuid[])`;
      }
      await closePostgresClients();
    });

    it("reads the seeded shop, services and split hours", async () => {
      expect(await store.getShop("harts")).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
      expect((await store.listServices("harts")).map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard"]);
      const [dana] = await store.getStaffHours("harts");
      expect(dana.staffName).toBe("Dana");
      expect(dana.weekly.filter((w) => w.weekday === 6)).toEqual([
        { weekday: 6, open: "09:00", close: "12:00" },
        { weekday: 6, open: "12:30", close: "17:00" },
      ]);
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
      const results = await Promise.allSettled([
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent A's customer" }, "vitest A"),
        book(deps, "harts", { service_id: "haircut", start, customer_name: "Agent B's customer" }, "vitest B"),
      ]);
      for (const r of results) if (r.status === "fulfilled") created.push(r.value.booking.id);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(FrontDeskError);
      expect((reason as FrontDeskError).code).toBe("slot_taken");
    });
  });
}
