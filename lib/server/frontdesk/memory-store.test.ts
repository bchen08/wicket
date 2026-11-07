import { describe, expect, it } from "vitest";
import type { BookingStatus, Policies } from "../../types/frontdesk";
import type { Clock } from "../clock";
import {
  IDEMPOTENCY_TTL_MS,
  SlotTakenError,
  type BookingStore,
  type IdempotencyScope,
  type NewBooking,
  type NewBookingEvent,
} from "./booking-store";
import { DepositExceedsPriceError, DuplicateServiceError } from "./catalog";
import { FrontDeskError } from "./errors";
import { createMemoryStore, SEED, type InitialBooking } from "./memory-store";
import { DEFAULT_POLICIES } from "./policies";
import { NOW } from "./test-support";

// The in-memory ShopCatalog + BookingStore. postgres-store.test.ts checks the same behaviours
// against Postgres. "Now" is Mon 9 Nov 2026, noon in New York; the bookings are on Sat 14 Nov.

const at = (hhmm: string) => new Date(`2026-11-14T${hhmm}:00-05:00`);
const SATURDAY = { start: at("00:00"), end: new Date("2026-11-15T00:00:00-05:00") };

const newBooking = (start: Date, end: Date, extra: Partial<NewBooking> = {}): NewBooking => ({
  shopSlug: "harts",
  serviceId: "haircut",
  staffId: "dana",
  start,
  end,
  customerName: "Memory Test",
  agentName: "vitest",
  depositCents: 1000,
  ...extra,
});

/** A preloaded haircut with dana; its deposit defaults to the service's. */
const initial = (start: Date, end: Date, status: BookingStatus): InitialBooking => ({
  shopSlug: "harts",
  serviceId: "haircut",
  staffId: "dana",
  start,
  end,
  customerName: "Memory Test",
  agentName: "vitest",
  status,
});

const cancelEvent = (actor: NewBookingEvent["actor"] = "agent"): NewBookingEvent => ({
  actor,
  type: "cancelled",
  data: { from: "confirmed", to: "cancelled", depositEffect: "released", depositCollected: false },
});

/** A clock tests can move. */
function mutableClock(start: Date = NOW): Clock & { advance(ms: number): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}

const scope = (key: string, requestHash = "hash-a", tool: IdempotencyScope["tool"] = "book"): IdempotencyScope => ({
  key,
  tool,
  requestHash,
});

/** Lets other pending promises run, so a test can interleave concurrent calls. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("seed", () => {
  it("has Hart's policies, as in supabase/seed.sql", async () => {
    const store = createMemoryStore();
    const policies = await store.getPolicies("harts");
    expect(policies).toEqual(SEED.policies.harts);
    expect(policies).toMatchObject({
      leadTimeMin: 120,
      horizonDays: 30,
      depositHorizonDays: 6,
      cancelWindowHours: 24,
      paused: false,
      phone: "+1 212-555-0142",
    });
    expect(policies?.lateCancelRule).toContain("24 hours");
    expect(await store.getPolicies("nope")).toBeNull();
  });

  it("merges the policies option over the seeded ones", async () => {
    const store = createMemoryStore({ policies: { paused: true, leadTimeMin: 0, phone: undefined } });
    expect(await store.getPolicies("harts")).toEqual({ ...SEED.policies.harts, paused: true, leadTimeMin: 0 });
  });

  it("defaults a preloaded booking's deposit to the service's and keeps an explicit one", async () => {
    const store = createMemoryStore({
      initialBookings: [
        initial(at("10:00"), at("10:30"), "confirmed"),
        { ...initial(at("11:00"), at("11:30"), "confirmed"), depositCents: 0 },
      ],
    });
    const listed = await store.listBookings("harts", SATURDAY);
    expect(listed.map((b) => b.depositCents)).toEqual([1000, 0]);
    expect(await store.listEvents(listed[0].id)).toEqual([]); // preloaded bookings have no history
  });
});

describe("getBusyIntervals", () => {
  it("returns awaiting_deposit and confirmed bookings and blocked times, sorted by start", async () => {
    const statuses: BookingStatus[] = ["awaiting_deposit", "confirmed", "cancelled", "expired", "completed", "no_show"];
    const store = createMemoryStore({
      // One booking per status, an hour apart from 9:00.
      initialBookings: statuses.map((status, i) => {
        const hh = String(9 + i).padStart(2, "0");
        return initial(at(`${hh}:00`), at(`${hh}:30`), status);
      }),
      initialBlocks: [{ staffId: "dana", start: at("09:30"), end: at("10:00"), reason: "Dentist" }],
    });
    const busy = await store.getBusyIntervals("harts", SATURDAY);
    expect(busy.map((b) => [b.kind, b.start.getTime(), b.end.getTime()])).toEqual([
      ["booking", at("09:00").getTime(), at("09:30").getTime()], // awaiting_deposit
      ["block", at("09:30").getTime(), at("10:00").getTime()],
      ["booking", at("10:00").getTime(), at("10:30").getTime()], // confirmed
    ]);
    expect(busy.every((b) => b.staffId === "dana")).toBe(true);
    expect(busy[1].reason).toMatch(/^block /);
    expect(await store.getBusyIntervals("nope", SATURDAY)).toEqual([]);
  });

  it("is half-open: an interval touching the range edge is not returned", async () => {
    const store = createMemoryStore({ initialBlocks: [{ staffId: "dana", start: at("09:00"), end: at("10:00"), reason: "" }] });
    expect(await store.getBusyIntervals("harts", { start: at("10:00"), end: at("11:00") })).toEqual([]);
    expect(await store.getBusyIntervals("harts", { start: at("09:59"), end: at("11:00") })).toHaveLength(1);
  });
});

describe("createBooking", () => {
  it("stores a confirmed booking with its deposit snapshot and writes a booked event", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30"), { depositCents: 777 }));
    expect(booking).toMatchObject({
      status: "confirmed",
      serviceName: "Haircut",
      depositCents: 777,
      start: "2026-11-14T10:00:00-05:00",
      createdAt: "2026-11-09T12:00:00-05:00",
    });

    const events = await store.listEvents(booking.id);
    expect(events).toEqual([
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "agent",
        type: "booked",
        data: { status: "confirmed", agentName: "vitest" },
      },
    ]);

    // A later price change doesn't rewrite the booking's deposit.
    await store.updateService("harts", "haircut", { depositCents: 2000 });
    expect((await store.getBooking(booking.id))?.depositCents).toBe(777);
  });

  it("refuses an overlap with an awaiting_deposit or confirmed booking, not with a final one", async () => {
    const store = createMemoryStore({
      initialBookings: [
        initial(at("10:00"), at("10:30"), "awaiting_deposit"),
        initial(at("11:00"), at("11:30"), "confirmed"),
        initial(at("13:00"), at("13:30"), "cancelled"),
        initial(at("14:00"), at("14:30"), "no_show"),
      ],
    });
    await expect(store.createBooking(newBooking(at("10:15"), at("10:45")))).rejects.toBeInstanceOf(SlotTakenError);
    await expect(store.createBooking(newBooking(at("11:15"), at("11:45")))).rejects.toBeInstanceOf(SlotTakenError);
    await expect(store.createBooking(newBooking(at("13:00"), at("13:30")))).resolves.toMatchObject({ status: "confirmed" });
    await expect(store.createBooking(newBooking(at("14:00"), at("14:30")))).resolves.toMatchObject({ status: "confirmed" });
    // Back to back is fine (half-open).
    await expect(store.createBooking(newBooking(at("10:30"), at("11:00")))).resolves.toMatchObject({ status: "confirmed" });
  });
});

describe("getBooking", () => {
  it("finds a booking by id (any case) and returns null for unknown or malformed ids", async () => {
    const store = createMemoryStore();
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    expect(await store.getBooking(booking.id)).toEqual(booking);
    expect(await store.getBooking(booking.id.toUpperCase())).toEqual(booking);
    expect(await store.getBooking(crypto.randomUUID())).toBeNull();
    expect(await store.getBooking("not-a-uuid")).toBeNull();
    expect(await store.getBooking("")).toBeNull();
  });
});

describe("transition", () => {
  it("moves the status, writes one event and stamps the time with the store clock", async () => {
    const clock = mutableClock();
    const store = createMemoryStore({ clock });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    clock.advance(60 * 60_000); // 1 pm

    const cancelled = await store.transition(booking.id, "confirmed", "cancelled", cancelEvent("owner"));
    expect(cancelled).toEqual({ ...booking, status: "cancelled" });
    expect(store.lifecycleStamps(booking.id)).toEqual({
      cancelledAt: new Date("2026-11-09T13:00:00-05:00"),
      cancelledBy: "owner",
      completedAt: null,
      noShowAt: null,
    });

    const events = await store.listEvents(booking.id);
    expect(events.map((e) => [e.type, e.actor, e.at])).toEqual([
      ["booked", "agent", "2026-11-09T12:00:00-05:00"],
      ["cancelled", "owner", "2026-11-09T13:00:00-05:00"],
    ]);
    expect(events[1].data).toEqual(cancelEvent().data);
    expect(Number(events[1].id)).toBeGreaterThan(Number(events[0].id));

    // The slot is free again.
    expect(await store.getBusyIntervals("harts", SATURDAY)).toEqual([]);
  });

  it("stamps completed_at and no_show_at", async () => {
    const clock = mutableClock();
    const store = createMemoryStore({ clock });
    const a = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const b = await store.createBooking(newBooking(at("11:00"), at("11:30")));
    clock.advance(5 * 24 * 60 * 60_000); // Sat 14 Nov, noon
    await store.transition(a.id, "confirmed", "completed", { actor: "owner", type: "completed", data: {} });
    await store.transition(b.id, "confirmed", "no_show", { actor: "owner", type: "no_show", data: {} });
    expect(store.lifecycleStamps(a.id)).toEqual({ cancelledAt: null, cancelledBy: null, completedAt: clock.now(), noShowAt: null });
    expect(store.lifecycleStamps(b.id)).toEqual({ cancelledAt: null, cancelledBy: null, completedAt: null, noShowAt: clock.now() });
  });

  it("returns null and writes nothing when the status isn't the expected one", async () => {
    const store = createMemoryStore();
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    expect(await store.transition(booking.id, "awaiting_deposit", "cancelled", cancelEvent())).toBeNull();
    expect((await store.getBooking(booking.id))?.status).toBe("confirmed");
    expect(await store.listEvents(booking.id)).toHaveLength(1);
    expect(store.lifecycleStamps(booking.id)?.cancelledAt).toBeNull();
  });

  it("returns null for an unknown or malformed id", async () => {
    const store = createMemoryStore();
    expect(await store.transition(crypto.randomUUID(), "confirmed", "cancelled", cancelEvent())).toBeNull();
    expect(await store.transition("nope", "confirmed", "cancelled", cancelEvent())).toBeNull();
  });

  it("lets exactly one of two concurrent transitions win, with exactly one event", async () => {
    const store = createMemoryStore();
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const results = await Promise.all([
      store.transition(booking.id, "confirmed", "cancelled", cancelEvent()),
      store.transition(booking.id, "confirmed", "no_show", { actor: "owner", type: "no_show", data: {} }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await store.listEvents(booking.id)).map((e) => e.type)).toEqual(["booked", "cancelled"]);
  });
});

describe("listEvents", () => {
  it("returns [] for a booking without events, an unknown id or a malformed id", async () => {
    const store = createMemoryStore();
    expect(await store.listEvents(crypto.randomUUID())).toEqual([]);
    expect(await store.listEvents("nope")).toEqual([]);
  });

  it("returns a copy of the event data", async () => {
    const store = createMemoryStore();
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const [first] = await store.listEvents(booking.id);
    first.data.status = "changed";
    expect((await store.listEvents(booking.id))[0].data.status).toBe("confirmed");
  });
});

describe("idempotent", () => {
  /** An action that books 10:00 and counts its runs. */
  function counted() {
    const counter = {
      runs: 0,
      action: async (s: BookingStore) => {
        counter.runs++;
        return { booking: await s.createBooking(newBooking(at("10:00"), at("10:30"))) };
      },
    };
    return counter;
  }

  it("runs the action once and replays a copy of its result for the same key and arguments", async () => {
    const store = createMemoryStore();
    const c = counted();
    const first = await store.idempotent(scope("key-00001"), c.action);
    expect(first.replayed).toBe(false);

    const second = await store.idempotent(scope("key-00001"), c.action);
    expect(second).toEqual({ result: first.result, replayed: true });
    expect(second.result).not.toBe(first.result);
    expect(c.runs).toBe(1);
    expect(await store.listBookings("harts", SATURDAY)).toHaveLength(1);
    expect(await store.listEvents(first.result.booking.id)).toHaveLength(1);

    // Mutating a replay doesn't change the saved response.
    second.result.booking.status = "cancelled";
    expect((await store.idempotent(scope("key-00001"), c.action)).result.booking.status).toBe("confirmed");
  });

  it("throws idempotency_conflict for the same key with different arguments, without running the action", async () => {
    const store = createMemoryStore();
    const c = counted();
    await store.idempotent(scope("key-00002", "hash-a"), c.action);
    const err = await store.idempotent(scope("key-00002", "hash-b"), c.action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrontDeskError);
    expect(err).toMatchObject({
      code: "idempotency_conflict",
      message: "This idempotency_key was already used with different arguments.",
      nextAction: "Use a new idempotency_key (a fresh UUID) for a different request.",
      details: { idempotency_key: "key-00002", tool: "book" },
    });
    expect(c.runs).toBe(1);
  });

  it("scopes keys per tool", async () => {
    const store = createMemoryStore();
    let runs = 0;
    const action = async () => ++runs;
    await store.idempotent(scope("key-00003", "hash-a", "book"), action);
    const other = await store.idempotent(scope("key-00003", "hash-b", "cancel"), action);
    expect(other).toEqual({ result: 2, replayed: false });
  });

  it("saves nothing when the action throws, so the next call runs it", async () => {
    const store = createMemoryStore();
    await expect(
      store.idempotent(scope("key-00004", "hash-a"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Even different arguments are fine: nothing was saved.
    const next = await store.idempotent(scope("key-00004", "hash-b"), async () => "ran");
    expect(next).toEqual({ result: "ran", replayed: false });
  });

  it("forgets a key after IDEMPOTENCY_TTL_MS (24 hours) by the store clock", async () => {
    const clock = mutableClock();
    const store = createMemoryStore({ clock });
    let runs = 0;
    const action = async () => ++runs;
    await store.idempotent(scope("key-00005"), action);

    clock.advance(IDEMPOTENCY_TTL_MS); // exactly 24 h: still remembered
    expect(await store.idempotent(scope("key-00005"), action)).toEqual({ result: 1, replayed: true });
    await expect(store.idempotent(scope("key-00005", "hash-b"), action)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });

    clock.advance(1); // past 24 h: the key may be reused, even with other arguments
    expect(await store.idempotent(scope("key-00005", "hash-b"), action)).toEqual({ result: 2, replayed: false });
    expect(await store.idempotent(scope("key-00005", "hash-b"), action)).toEqual({ result: 2, replayed: true });
  });

  it("serializes concurrent calls with the same key: the action runs once and both get its result", async () => {
    const store = createMemoryStore();
    const c = counted();
    const slow = async (s: BookingStore) => {
      await tick();
      return c.action(s);
    };
    const [a, b] = await Promise.all([
      store.idempotent(scope("key-00006"), slow),
      store.idempotent(scope("key-00006"), slow),
    ]);
    expect(c.runs).toBe(1);
    expect(a.result).toEqual(b.result);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await store.listBookings("harts", SATURDAY)).toHaveLength(1);
  });

  it("runs a waiting call's action when the in-flight one throws", async () => {
    const store = createMemoryStore();
    let runs = 0;
    const first = store.idempotent(scope("key-00007"), async () => {
      runs++;
      await tick();
      throw new Error("first failed");
    });
    const second = store.idempotent(scope("key-00007"), async () => {
      runs++;
      return "second ran";
    });
    await expect(first).rejects.toThrow("first failed");
    expect(await second).toEqual({ result: "second ran", replayed: false });
    expect(runs).toBe(2);
  });

  it("gives the action a store whose writes are visible, but whose idempotent() can't nest", async () => {
    const store = createMemoryStore();
    const { result } = await store.idempotent(scope("key-00008"), async (s) => {
      const booking = await s.createBooking(newBooking(at("10:00"), at("10:30")));
      await expect(s.idempotent(scope("key-00009"), async () => 1)).rejects.toThrow(/can't be nested/);
      return booking;
    });
    expect(await store.getBooking(result.id)).toEqual(result);
  });

  it("keeps an action's writes when it throws afterwards (no rollback in memory)", async () => {
    const store = createMemoryStore();
    await expect(
      store.idempotent(scope("key-00010"), async (s) => {
        await s.createBooking(newBooking(at("10:00"), at("10:30")));
        throw new Error("after the write");
      }),
    ).rejects.toThrow("after the write");
    expect(await store.listBookings("harts", SATURDAY)).toHaveLength(1);
  });
});

describe("owner writes", () => {
  it("are isolated between stores and never touch SEED", async () => {
    const seedBefore = structuredClone(SEED);
    const a = createMemoryStore();
    const b = createMemoryStore();
    await a.savePolicies("harts", { ...SEED.policies.harts, paused: true });
    await a.createService("harts", { id: "shave", name: "Shave", durationMin: 20, priceCents: 2000, depositCents: 0 });
    await a.updateService("harts", "haircut", { priceCents: 9999 });
    await a.replaceWeeklyHours("harts", "dana", []);
    await a.createBlock("harts", { staffId: "dana", start: at("09:00"), end: at("17:00"), reason: "Holiday" });

    expect((await a.getPolicies("harts"))?.paused).toBe(true);
    expect(await b.getPolicies("harts")).toEqual(SEED.policies.harts);
    expect((await b.listServices("harts")).map((s) => [s.id, s.priceCents])).toEqual([
      ["haircut", 3500],
      ["beard-trim", 1500],
      ["haircut-beard", 4500],
    ]);
    expect((await b.getStaffHours("harts"))[0].weekly).toHaveLength(10);
    expect(await b.listBlocks("harts", SATURDAY)).toEqual([]);
    expect(SEED).toEqual(seedBefore);
  });

  it("round-trips policies", async () => {
    const store = createMemoryStore();
    const next: Policies = {
      leadTimeMin: 60,
      horizonDays: 14,
      depositHorizonDays: 3,
      cancelWindowHours: 12,
      paused: true,
      phone: null,
      depositRule: "d",
      lateCancelRule: "l",
      noShowRule: "n",
    };
    expect(await store.savePolicies("harts", { ...next, extra: "ignored" } as Policies)).toEqual(next);
    expect(await store.getPolicies("harts")).toEqual(next);
    await expect(store.savePolicies("nope", next)).rejects.toThrow();
  });

  it("savePolicies merges a patch: concurrent patches of different fields both take effect", async () => {
    const store = createMemoryStore();
    await Promise.all([store.savePolicies("harts", { paused: true }), store.savePolicies("harts", { leadTimeMin: 60 })]);
    expect(await store.getPolicies("harts")).toEqual({ ...SEED.policies.harts, paused: true, leadTimeMin: 60 });
  });

  it("savePolicies keeps fields that are undefined in the patch, and phone: null clears the phone", async () => {
    const store = createMemoryStore();
    expect(await store.savePolicies("harts", { paused: undefined, phone: undefined, noShowRule: "n" })).toEqual({
      ...SEED.policies.harts,
      noShowRule: "n",
    });
    expect(await store.savePolicies("harts", { phone: null })).toEqual({ ...SEED.policies.harts, noShowRule: "n", phone: null });
    expect(await store.getPolicies("harts")).toEqual({ ...SEED.policies.harts, noShowRule: "n", phone: null });
  });

  it("savePolicies on a shop without a row stores the defaults plus the patch", async () => {
    const store = createMemoryStore({ policies: null });
    expect(await store.getPolicies("harts")).toBeNull();
    expect(await store.savePolicies("harts", { paused: true, phone: "+1 555-0100" })).toEqual({
      ...DEFAULT_POLICIES,
      paused: true,
      phone: "+1 555-0100",
    });
    expect(await store.getPolicies("harts")).toEqual({ ...DEFAULT_POLICIES, paused: true, phone: "+1 555-0100" });
  });

  it("creates services at the end of the list and patches only the given fields", async () => {
    const store = createMemoryStore();
    const shave = { id: "shave", name: "Shave", durationMin: 20, priceCents: 2000, depositCents: 500 };
    expect(await store.createService("harts", shave)).toEqual(shave);
    expect((await store.listServices("harts")).map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard", "shave"]);

    const err = await store.createService("harts", { ...shave, name: "Other" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateServiceError);
    expect((err as DuplicateServiceError).serviceId).toBe("shave");

    expect(await store.updateService("harts", "shave", { priceCents: 2500, name: undefined })).toEqual({ ...shave, priceCents: 2500 });
    expect((await store.listServices("harts")).find((s) => s.id === "shave")).toEqual({ ...shave, priceCents: 2500 });
    expect(await store.updateService("harts", "perm", { priceCents: 1 })).toBeNull();
    expect(await store.updateService("nope", "shave", { priceCents: 1 })).toBeNull();
  });

  it("refuses a deposit larger than the price, judged against the row as it is when the update applies", async () => {
    const store = createMemoryStore();
    const haircut = SEED.services.harts[0]; // 3500 price, 1000 deposit
    // Each patch is fine against the seeded row; together they'd leave a 3000 deposit on a 2000 price.
    const results = await Promise.allSettled([
      store.updateService("harts", "haircut", { depositCents: 3000 }),
      store.updateService("harts", "haircut", { priceCents: 2000 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(DepositExceedsPriceError);
    expect((reason as DepositExceedsPriceError).serviceId).toBe("haircut");
    const stored = (await store.listServices("harts")).find((s) => s.id === "haircut")!;
    expect(stored.depositCents).toBeLessThanOrEqual(stored.priceCents);
    expect(stored).toEqual({ ...haircut, depositCents: 3000 }); // the first one applied, the second changed nothing

    const err = await store
      .createService("harts", { id: "shave", name: "Shave", durationMin: 20, priceCents: 2000, depositCents: 2001 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DepositExceedsPriceError);
    expect((await store.listServices("harts")).map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard"]);
  });

  it("replaces a staff member's whole week, sorted, and refuses staff outside the shop", async () => {
    const store = createMemoryStore();
    const week = [
      { weekday: 3 as const, open: "13:00", close: "17:00" },
      { weekday: 1 as const, open: "09:00", close: "12:00" },
      { weekday: 3 as const, open: "08:00", close: "12:00" },
    ];
    expect(await store.replaceWeeklyHours("harts", "dana", week)).toBe(true);
    expect(await store.getStaffHours("harts")).toEqual([
      {
        staffId: "dana",
        staffName: "Dana",
        weekly: [
          { weekday: 1, open: "09:00", close: "12:00" },
          { weekday: 3, open: "08:00", close: "12:00" },
          { weekday: 3, open: "13:00", close: "17:00" },
        ],
      },
    ]);
    expect(await store.replaceWeeklyHours("harts", "nobody", week)).toBe(false);
    expect(await store.replaceWeeklyHours("nope", "dana", week)).toBe(false);
    expect(await store.replaceWeeklyHours("harts", "dana", [])).toBe(true);
    expect((await store.getStaffHours("harts"))[0].weekly).toEqual([]);
  });

  it("creates, lists and deletes blocked times, scoped to the shop", async () => {
    const store = createMemoryStore();
    const afternoon = await store.createBlock("harts", { staffId: "dana", start: at("13:00"), end: at("17:00"), reason: "Holiday" });
    const morning = await store.createBlock("harts", { staffId: "dana", start: at("09:00"), end: at("10:00"), reason: "" });
    expect(afternoon).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      staffId: "dana",
      start: "2026-11-14T13:00:00-05:00",
      end: "2026-11-14T17:00:00-05:00",
      reason: "Holiday",
    });
    expect(await store.listBlocks("harts", SATURDAY)).toEqual([morning, afternoon]);
    expect(await store.listBlocks("harts", { start: at("10:00"), end: at("13:00") })).toEqual([]); // half-open
    expect(await store.listBlocks("nope", SATURDAY)).toEqual([]);
    expect((await store.getBusyIntervals("harts", SATURDAY)).map((b) => b.kind)).toEqual(["block", "block"]);

    expect(await store.createBlock("harts", { staffId: "nobody", start: at("09:00"), end: at("10:00"), reason: "" })).toBeNull();
    await expect(store.createBlock("harts", { staffId: "dana", start: at("10:00"), end: at("10:00"), reason: "" })).rejects.toThrow();
    await expect(
      store.createBlock("harts", { staffId: "dana", start: at("10:00"), end: at("11:00"), reason: "x".repeat(201) }),
    ).rejects.toThrow();

    expect(await store.deleteBlock("nope", afternoon!.id)).toBeNull();
    expect(await store.deleteBlock("harts", "not-a-uuid")).toBeNull();
    expect(await store.deleteBlock("harts", afternoon!.id)).toEqual(afternoon);
    expect(await store.deleteBlock("harts", afternoon!.id)).toBeNull();
    expect(await store.listBlocks("harts", SATURDAY)).toEqual([morning]);
  });
});
