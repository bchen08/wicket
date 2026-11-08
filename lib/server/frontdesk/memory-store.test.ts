import { describe, expect, it } from "vitest";
import type { BookingStatus, Policies } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { SlotTakenError, type ApprovalAnswer, type NewBooking, type NewBookingEvent } from "./booking-store";
import { DepositExceedsPriceError, DuplicateServiceError } from "./catalog";
import { createMemoryStore, SEED, type InitialBooking } from "./memory-store";
import { DEFAULT_POLICIES } from "./policies";
import { customerOf, holdFields, NOW, PHONE_E164 } from "./test-support";

// The in-memory ShopCatalog + BookingStore. postgres-store.test.ts checks the same behaviours
// against Postgres. "Now" is Mon 9 Nov 2026, noon in New York; the bookings are on Sat 14 Nov.

const at = (hhmm: string) => new Date(`2026-11-14T${hhmm}:00-05:00`);
const SATURDAY = { start: at("00:00"), end: new Date("2026-11-15T00:00:00-05:00") };

/** NOW + 10 minutes: the hold deadline createBooking gets by default. */
const HOLD_UNTIL = new Date(NOW.getTime() + 10 * 60_000);

const newBooking = (start: Date, end: Date, extra: Partial<NewBooking> = {}): NewBooking => ({
  shopSlug: "harts",
  serviceId: "haircut",
  staffId: "dana",
  start,
  end,
  customerName: "Memory Test",
  agentName: "vitest",
  depositCents: 1000,
  ...holdFields(HOLD_UNTIL),
  ...extra,
});

/** A preloaded haircut with dana; its deposit defaults to the service's. A hold gets HOLD_UNTIL. */
const initial = (start: Date, end: Date, status: BookingStatus): InitialBooking => ({
  shopSlug: "harts",
  serviceId: "haircut",
  staffId: "dana",
  start,
  end,
  customerName: "Memory Test",
  agentName: "vitest",
  status,
  ...(status === "awaiting_approval" ? { approveBy: HOLD_UNTIL } : {}),
});

const cancelEvent = (actor: NewBookingEvent["actor"] = "agent"): NewBookingEvent => ({
  actor,
  type: "cancelled",
  data: { from: "awaiting_approval", to: "cancelled", depositEffect: "released", depositCollected: false },
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
  it("returns awaiting_approval, awaiting_deposit and confirmed bookings and blocked times, sorted by start", async () => {
    const statuses: BookingStatus[] = [
      "awaiting_deposit",
      "confirmed",
      "cancelled",
      "expired",
      "completed",
      "no_show",
      "awaiting_approval",
    ];
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
      ["booking", at("15:00").getTime(), at("15:30").getTime()], // awaiting_approval
    ]);
    expect(busy.every((b) => b.staffId === "dana")).toBe(true);
    expect(busy[1].reason).toMatch(/^block /);
    // Only the hold carries a deadline.
    expect(busy.map((b) => b.heldUntil)).toEqual([undefined, undefined, undefined, HOLD_UNTIL]);
    expect(await store.getBusyIntervals("nope", SATURDAY)).toEqual([]);
  });

  it("is half-open: an interval touching the range edge is not returned", async () => {
    const store = createMemoryStore({ initialBlocks: [{ staffId: "dana", start: at("09:00"), end: at("10:00"), reason: "" }] });
    expect(await store.getBusyIntervals("harts", { start: at("10:00"), end: at("11:00") })).toEqual([]);
    expect(await store.getBusyIntervals("harts", { start: at("09:59"), end: at("11:00") })).toHaveLength(1);
  });
});

describe("createBooking", () => {
  it("stores a held booking with its deposit snapshot, its approval request, and writes a booked event", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const fields = newBooking(at("10:00"), at("10:30"), { depositCents: 777 });
    const booking = await store.createBooking(fields);
    expect(booking).toMatchObject({
      status: "awaiting_approval",
      serviceName: "Haircut",
      depositCents: 777,
      start: "2026-11-14T10:00:00-05:00",
      createdAt: "2026-11-09T12:00:00-05:00",
      customer: customerOf("Memory Test", false),
    });
    expect(booking.customer).not.toHaveProperty("phone");
    // The store knows the token but not the request's origin: the link is a path until the service layer adds it.
    expect(booking.approval).toEqual({ url: `/approve/${fields.approvalToken}`, expiresAt: "2026-11-09T12:10:00-05:00" });

    const events = await store.listEvents(booking.id);
    expect(events).toEqual([
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "agent",
        type: "booked",
        data: { status: "awaiting_approval", agentName: "vitest" },
      },
    ]);

    const rows = store.consentRows();
    expect(rows.bookings).toEqual([{ id: booking.id, approveBy: HOLD_UNTIL, customerPhone: null, mandate: null }]);
    expect(rows.approvals).toEqual([
      { bookingId: booking.id, token: fields.approvalToken, createdAt: NOW, decidedAt: null, decision: null },
    ]);
    expect(await store.findApproval(fields.approvalToken)).toEqual({
      bookingId: booking.id,
      decision: null,
      approveBy: HOLD_UNTIL,
      mandate: null,
    });

    // A later price change doesn't rewrite the booking's deposit.
    await store.updateService("harts", "haircut", { depositCents: 2000 });
    expect((await store.getBooking(booking.id))?.depositCents).toBe(777);
  });

  it("stores the mandate on the booking and in the booked event", async () => {
    const store = createMemoryStore();
    const mandate = { priceCapCents: 5000, window: { from: "2026-11-14T09:00:00-05:00", to: "2026-11-14T12:00:00-05:00" } };
    const fields = newBooking(at("10:00"), at("10:30"), { mandate });
    const booking = await store.createBooking(fields);
    expect(store.consentRows().bookings[0].mandate).toEqual(mandate);
    expect((await store.listEvents(booking.id))[0].data).toEqual({ status: "awaiting_approval", agentName: "vitest", mandate });
    expect((await store.findApproval(fields.approvalToken))?.mandate).toEqual(mandate);
  });

  it("refuses an overlap with an awaiting_approval, awaiting_deposit or confirmed booking, not with a final one", async () => {
    const store = createMemoryStore({
      initialBookings: [
        initial(at("10:00"), at("10:30"), "awaiting_deposit"),
        initial(at("11:00"), at("11:30"), "confirmed"),
        initial(at("13:00"), at("13:30"), "cancelled"),
        initial(at("14:00"), at("14:30"), "no_show"),
        initial(at("15:00"), at("15:30"), "awaiting_approval"),
        initial(at("16:00"), at("16:30"), "expired"),
      ],
    });
    const held = { status: "awaiting_approval" };
    await expect(store.createBooking(newBooking(at("10:15"), at("10:45")))).rejects.toBeInstanceOf(SlotTakenError);
    await expect(store.createBooking(newBooking(at("11:15"), at("11:45")))).rejects.toBeInstanceOf(SlotTakenError);
    await expect(store.createBooking(newBooking(at("15:15"), at("15:45")))).rejects.toBeInstanceOf(SlotTakenError);
    await expect(store.createBooking(newBooking(at("13:00"), at("13:30")))).resolves.toMatchObject(held);
    await expect(store.createBooking(newBooking(at("14:00"), at("14:30")))).resolves.toMatchObject(held);
    await expect(store.createBooking(newBooking(at("16:00"), at("16:30")))).resolves.toMatchObject(held);
    // Back to back is fine (half-open).
    await expect(store.createBooking(newBooking(at("10:30"), at("11:00")))).resolves.toMatchObject(held);
  });

  it("refuses an overlap with a lapsed hold nobody expired yet (like the no_overlap constraint)", async () => {
    const clock = mutableClock();
    const store = createMemoryStore({ clock });
    await store.createBooking(newBooking(at("10:00"), at("10:30")));
    clock.advance(11 * 60_000); // past HOLD_UNTIL
    await expect(store.createBooking(newBooking(at("10:00"), at("10:30")))).rejects.toBeInstanceOf(SlotTakenError);
    expect(await store.expireStaleHolds("harts", SATURDAY, clock.now())).toBe(1);
    await expect(store.createBooking(newBooking(at("10:00"), at("10:30")))).resolves.toMatchObject({ status: "awaiting_approval" });
  });

  it("refuses a hold without a deadline and a reused token", async () => {
    const store = createMemoryStore();
    const fields = newBooking(at("10:00"), at("10:30"));
    await store.createBooking(fields);
    await expect(
      store.createBooking(newBooking(at("11:00"), at("11:30"), { approvalToken: fields.approvalToken })),
    ).rejects.toThrow(/unique/);
    expect(() =>
      createMemoryStore({ initialBookings: [{ ...initial(at("10:00"), at("10:30"), "awaiting_approval"), approveBy: undefined }] }),
    ).toThrow(/approveBy/);
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

    const cancelled = await store.transition(booking.id, "awaiting_approval", "cancelled", cancelEvent("owner"));
    expect(cancelled).toEqual({ ...booking, approval: undefined, status: "cancelled" });
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
    // The store doesn't judge the lifecycle (decide() does): it moves whatever it's told to.
    await store.transition(a.id, "awaiting_approval", "completed", { actor: "owner", type: "completed", data: {} });
    await store.transition(b.id, "awaiting_approval", "no_show", { actor: "owner", type: "no_show", data: {} });
    expect(store.lifecycleStamps(a.id)).toEqual({ cancelledAt: null, cancelledBy: null, completedAt: clock.now(), noShowAt: null });
    expect(store.lifecycleStamps(b.id)).toEqual({ cancelledAt: null, cancelledBy: null, completedAt: null, noShowAt: clock.now() });
  });

  it("returns null and writes nothing when the status isn't the expected one", async () => {
    const store = createMemoryStore();
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    expect(await store.transition(booking.id, "awaiting_deposit", "cancelled", cancelEvent())).toBeNull();
    expect((await store.getBooking(booking.id))?.status).toBe("awaiting_approval");
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
      store.transition(booking.id, "awaiting_approval", "cancelled", cancelEvent()),
      store.transition(booking.id, "awaiting_approval", "no_show", { actor: "owner", type: "no_show", data: {} }),
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
    expect((await store.listEvents(booking.id))[0].data.status).toBe("awaiting_approval");
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

// ---- Ring 1b: lazy expiry and consent ----

describe("lazy expiry", () => {
  it("refreshBooking expires a lapsed hold once, with one expired event by the system", async () => {
    const clock = mutableClock();
    const store = createMemoryStore({ clock });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));

    // Before the deadline: unchanged, no event.
    expect(await store.refreshBooking(booking.id, new Date(HOLD_UNTIL.getTime() - 1))).toEqual(booking);
    expect(await store.listEvents(booking.id)).toHaveLength(1);

    // At the deadline: expired.
    clock.advance(10 * 60_000);
    expect(await store.refreshBooking(booking.id.toUpperCase(), HOLD_UNTIL)).toEqual({ ...booking, approval: undefined, status: "expired" });
    expect(await store.refreshBooking(booking.id, HOLD_UNTIL)).toEqual({ ...booking, approval: undefined, status: "expired" });
    const events = await store.listEvents(booking.id);
    expect(events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
    expect(events[1].data).toEqual({ from: "awaiting_approval", to: "expired", depositEffect: "released", depositCollected: false });
    expect(await store.getBusyIntervals("harts", SATURDAY)).toEqual([]);
  });

  it("refreshBooking leaves other statuses alone and returns null for unknown or malformed ids", async () => {
    const store = createMemoryStore({ initialBookings: [initial(at("10:00"), at("10:30"), "confirmed")] });
    const [confirmed] = await store.listBookings("harts", SATURDAY);
    expect(await store.refreshBooking(confirmed.id, new Date("2030-01-01T00:00:00Z"))).toEqual(confirmed);
    expect(await store.listEvents(confirmed.id)).toEqual([]);
    expect(await store.refreshBooking(crypto.randomUUID(), NOW)).toBeNull();
    expect(await store.refreshBooking("nope", NOW)).toBeNull();
  });

  it("an expired event for a booking without a deposit says depositEffect none", async () => {
    const store = createMemoryStore();
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:15"), { serviceId: "beard-trim", depositCents: 0 }));
    await store.refreshBooking(booking.id, HOLD_UNTIL);
    expect((await store.listEvents(booking.id))[1].data).toMatchObject({ depositEffect: "none" });
  });

  it("expireStaleHolds expires only the shop's lapsed holds overlapping the range", async () => {
    const store = createMemoryStore();
    const later = new Date(HOLD_UNTIL.getTime() + 60 * 60_000);
    const lapsed = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const live = await store.createBooking(newBooking(at("11:00"), at("11:30"), { approveBy: later }));
    const outside = await store.createBooking(
      newBooking(new Date("2026-11-17T10:00:00-05:00"), new Date("2026-11-17T10:30:00-05:00")),
    );

    expect(await store.expireStaleHolds("nope", SATURDAY, HOLD_UNTIL)).toBe(0);
    expect(await store.expireStaleHolds("harts", SATURDAY, HOLD_UNTIL)).toBe(1);
    expect(await store.expireStaleHolds("harts", SATURDAY, HOLD_UNTIL)).toBe(0); // a second pass expires nothing more: one event per hold
    expect((await store.getBooking(lapsed.id))?.status).toBe("expired");
    expect((await store.getBooking(live.id))?.status).toBe("awaiting_approval");
    expect((await store.getBooking(outside.id))?.status).toBe("awaiting_approval");
    expect((await store.listEvents(lapsed.id)).map((e) => e.type)).toEqual(["booked", "expired"]);
  });

  it("getBusyIntervals still returns a lapsed hold, with its deadline, until something expires it", async () => {
    const store = createMemoryStore();
    await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const busy = await store.getBusyIntervals("harts", SATURDAY);
    expect(busy).toHaveLength(1);
    expect(busy[0].heldUntil).toEqual(HOLD_UNTIL);
    expect(busy[0].heldUntil).not.toBe(HOLD_UNTIL); // a copy
  });
});

describe("transition: actors", () => {
  it("stamps cancelled_by customer, and refuses a cancel by the system", async () => {
    const store = createMemoryStore();
    const a = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const b = await store.createBooking(newBooking(at("11:00"), at("11:30")));
    await store.transition(a.id, "awaiting_approval", "cancelled", cancelEvent("customer"));
    expect(store.lifecycleStamps(a.id)?.cancelledBy).toBe("customer");
    await expect(store.transition(b.id, "awaiting_approval", "cancelled", cancelEvent("system"))).rejects.toThrow();
    expect((await store.getBooking(b.id))?.status).toBe("awaiting_approval");
  });
});

describe("consent: answerApproval", () => {
  const PHONE = "+14015550123";

  const approved = (bookingId: string, now = NOW, phone: string | null = PHONE): ApprovalAnswer => ({
    bookingId,
    decision: "approved",
    nextStatus: "confirmed",
    now,
    phone,
    event: {
      actor: "customer",
      type: "approved",
      data: { from: "awaiting_approval", to: "confirmed", depositEffect: "none", depositCollected: false },
    },
  });

  it("approves with a phone: confirmed, approved, customer.phone from the stored E.164 number, approval decided", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const result = await store.answerApproval(approved(booking.id));
    expect(result).toEqual({
      ok: true,
      booking: { ...booking, approval: undefined, status: "confirmed", customer: customerOf("Memory Test", true, PHONE_E164) },
    });
    const rows = store.consentRows();
    expect(rows.bookings[0].customerPhone).toBe(PHONE);
    expect(rows.approvals[0]).toMatchObject({ decision: "approved", decidedAt: NOW });
    expect((await store.listEvents(booking.id)).map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["approved", "customer"],
    ]);
    expect(await store.getBooking(booking.id)).toEqual(result.ok && result.booking);
  });

  it("approves without a phone: approved, no customer.phone, nothing stored", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const result = await store.answerApproval(approved(booking.id, NOW, null));
    expect(result).toEqual({
      ok: true,
      booking: { ...booking, approval: undefined, status: "confirmed", customer: customerOf("Memory Test", true) },
    });
    expect(store.consentRows().bookings[0].customerPhone).toBeNull();
  });

  it("refuses a phone that isn't E.164 (the customer_phone check) and changes nothing", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    await expect(store.answerApproval(approved(booking.id, NOW, "4015550123"))).rejects.toThrow(/E\.164/);
    expect((await store.getBooking(booking.id))?.status).toBe("awaiting_approval");
    expect(store.consentRows().approvals[0].decision).toBeNull();
  });

  it("is not_pending once decided; nothing changes", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    await store.answerApproval(approved(booking.id));
    const before = store.consentRows();
    expect(await store.answerApproval(approved(booking.id, NOW, "+14015550199"))).toEqual({ ok: false, reason: "not_pending" });
    expect(
      await store.answerApproval({
        bookingId: booking.id,
        decision: "declined",
        nextStatus: "cancelled",
        now: NOW,
        event: { actor: "customer", type: "declined", data: {} },
      }),
    ).toEqual({ ok: false, reason: "not_pending" });
    expect(store.consentRows()).toEqual(before);
    expect(await store.listEvents(booking.id)).toHaveLength(2);
  });

  it("is not_pending once the hold's deadline has passed, and writes nothing", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    expect(await store.answerApproval(approved(booking.id, HOLD_UNTIL))).toEqual({ ok: false, reason: "not_pending" });
    expect((await store.getBooking(booking.id))?.status).toBe("awaiting_approval");
    expect(store.consentRows().bookings[0].customerPhone).toBeNull();
    expect(store.consentRows().approvals[0].decision).toBeNull();
  });

  it("is not_pending for an unknown or malformed booking id, or one without an approval request", async () => {
    const store = createMemoryStore({ clock: mutableClock(), initialBookings: [initial(at("12:30"), at("13:00"), "confirmed")] });
    const [preloaded] = await store.listBookings("harts", SATURDAY);
    for (const id of [crypto.randomUUID(), "not-a-uuid", preloaded.id]) {
      expect(await store.answerApproval(approved(id))).toEqual({ ok: false, reason: "not_pending" });
    }
  });

  it("declines: cancelled by the customer, approval decided, no phone stored", async () => {
    const store = createMemoryStore({ clock: mutableClock() });
    const booking = await store.createBooking(newBooking(at("10:00"), at("10:30")));
    const result = await store.answerApproval({
      bookingId: booking.id,
      decision: "declined",
      nextStatus: "cancelled",
      now: NOW,
      phone: PHONE,
      event: { actor: "customer", type: "declined", data: { from: "awaiting_approval", to: "cancelled" } },
    });
    expect(result).toEqual({ ok: true, booking: { ...booking, approval: undefined, status: "cancelled" } });
    expect(store.lifecycleStamps(booking.id)).toMatchObject({ cancelledBy: "customer", cancelledAt: NOW });
    expect(store.consentRows()).toMatchObject({ approvals: [{ decision: "declined" }], bookings: [{ customerPhone: null }] });
    expect(await store.getBusyIntervals("harts", SATURDAY)).toEqual([]);
  });
});
