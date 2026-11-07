import { describe, expect, it } from "vitest";
import type { Booking, CancelInput } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { FrontDeskError } from "./errors";
import { SEED } from "./memory-store";
import {
  book,
  cancelBooking,
  getAvailability,
  getBooking,
  getPolicies,
  type FrontDeskDeps,
} from "./service";
import { memoryDeps, NOW, SAT, withCatalog } from "./test-support";

// The agent's cancel, get_booking and get_policies use cases against the in-memory store. "Now" is
// Mon 9 Nov 2026, noon in New York. Hart's cancel window is 24 hours; haircut has a $10 deposit,
// beard-trim none.

const at = (hhmm: string) => `2026-11-14T${hhmm}:00-05:00`;
const key = () => crypto.randomUUID();
const HOUR_MS = 60 * 60 * 1000;

/** A clock tests can move. */
function mutableClock(start: Date = NOW): Clock & { set(instant: string): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set(instant) {
      t = new Date(instant).getTime();
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<FrontDeskError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FrontDeskError);
    return err as FrontDeskError;
  }
  throw new Error("expected a FrontDeskError");
}

async function bookAt(deps: FrontDeskDeps, start: string, service_id = "haircut"): Promise<Booking> {
  const { booking } = await book(
    deps,
    "harts",
    { service_id, start, customer_name: "Maya", idempotency_key: key() },
    "test-agent",
  );
  return booking;
}

const cancel = (deps: FrontDeskDeps, booking_id: string, idempotency_key = key()) =>
  cancelBooking(deps, "harts", { booking_id, idempotency_key });

/** Deps that also know a second shop, "elsewhere", with no bookings of its own. */
function withSecondShop(deps: FrontDeskDeps): FrontDeskDeps {
  return withCatalog(deps, (catalog) => ({
    getShop: async (slug: string) =>
      slug === "elsewhere"
        ? { slug: "elsewhere", name: "Elsewhere Cuts", timezone: "America/New_York" }
        : catalog.getShop(slug),
  }));
}

describe("cancelBooking", () => {
  it("cancels more than 24 hours ahead: cancelled, deposit released, nothing collected, slot offered again", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    const starts = async () =>
      (await getAvailability(deps, "harts", { service_id: "haircut", ...SAT, limit: 50 })).slots.map((s) => s.start);
    expect(await starts()).not.toContain(at("14:30"));

    const result = await cancel(deps, booking.id);

    expect(result).toEqual({
      booking: { ...booking, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
      replayed: false,
    });
    expect(await starts()).toContain(at("14:30"));
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("cancelled");
  });

  it("captures the deposit when cancelling inside 24 hours (but before the start)", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, "2026-11-10T10:00:00-05:00"); // 22 hours ahead
    const result = await cancel(deps, booking.id);
    expect(result.booking.status).toBe("cancelled");
    expect(result.depositEffect).toBe("captured");
    expect(result.depositCollected).toBe(false);
  });

  it("releases at exactly 24 hours ahead and captures a minute later", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const onTime = await bookAt(deps, at("14:30"));
    const late = await bookAt(deps, at("16:00"));
    clock.set("2026-11-13T14:30:00-05:00");
    expect((await cancel(deps, onTime.id)).depositEffect).toBe("released");
    clock.set("2026-11-13T16:01:00-05:00");
    expect((await cancel(deps, late.id)).depositEffect).toBe("captured");
  });

  it("is not_cancellable once the appointment has started", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const booking = await bookAt(deps, at("14:30"));
    clock.set(at("14:30"));
    const err = await rejection(cancel(deps, booking.id));
    expect(err.code).toBe("not_cancellable");
    expect(err.message).toBe("This appointment has already started.");
    expect(err.nextAction).toMatch(/call the shop at \+1 212-555-0142/);
    expect(err.details).toMatchObject({ status: "confirmed", booking_id: booking.id, start: at("14:30") });
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("confirmed");
  });

  it("reports depositEffect none for a service without a deposit, inside or outside the window", async () => {
    const deps = memoryDeps();
    const early = await bookAt(deps, at("14:30"), "beard-trim");
    const soon = await bookAt(deps, "2026-11-10T10:00:00-05:00", "beard-trim");
    expect((await cancel(deps, early.id)).depositEffect).toBe("none");
    expect((await cancel(deps, soon.id)).depositEffect).toBe("none");
  });

  it("is not_cancellable for a booking that is already cancelled (with a new key)", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    await cancel(deps, booking.id);
    const err = await rejection(cancel(deps, booking.id));
    expect(err.code).toBe("not_cancellable");
    expect(err.message).toBe("This booking is already cancelled.");
    expect(err.details).toMatchObject({ status: "cancelled" });
  });

  it.each<[string, string]>([
    ["a random UUID", "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c"],
    ["a malformed id", "not-a-uuid"],
  ])("is booking_not_found for %s", async (_label, id) => {
    const deps = memoryDeps();
    for (const err of [
      await rejection(cancel(deps, id)),
      await rejection(getBooking(deps, "harts", { booking_id: id })),
    ]) {
      expect(err.code).toBe("booking_not_found");
      expect(err.details).toEqual({ booking_id: id });
      expect(err.nextAction).toMatch(/booking\.id/);
    }
  });

  it("is booking_not_found for another shop's booking", async () => {
    const deps = withSecondShop(memoryDeps());
    const booking = await bookAt(deps, at("14:30"));
    const viaCancel = await rejection(cancelBooking(deps, "elsewhere", { booking_id: booking.id, idempotency_key: key() }));
    const viaGet = await rejection(getBooking(deps, "elsewhere", { booking_id: booking.id }));
    expect(viaCancel.code).toBe("booking_not_found");
    expect(viaGet.code).toBe("booking_not_found");
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("confirmed");
  });

  it("is not_found for an unknown shop", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    expect((await rejection(cancelBooking(deps, "nope", { booking_id: booking.id, idempotency_key: key() }))).code).toBe(
      "not_found",
    );
    expect((await rejection(getBooking(deps, "nope", { booking_id: booking.id }))).code).toBe("not_found");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a missing booking_id", { idempotency_key: "cancel-key-0001" }, "booking_id"],
    ["an empty booking_id", { booking_id: "  ", idempotency_key: "cancel-key-0001" }, "booking_id"],
    ["a numeric booking_id", { booking_id: 7, idempotency_key: "cancel-key-0001" }, "booking_id"],
    ["a missing idempotency_key", { booking_id: "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c" }, "idempotency_key"],
    ["a short idempotency_key", { booking_id: "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c", idempotency_key: "short" }, "idempotency_key"],
  ])("is invalid_request for %s", async (_label, args, field) => {
    const err = await rejection(cancelBooking(memoryDeps(), "harts", args as unknown as CancelInput));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field });
  });

  it("replays the same key: the same result, replayed true, still exactly one cancelled event", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    const k = key();
    const first = await cancel(deps, booking.id, k);
    const again = await cancel(deps, booking.id, k);
    // The same booking id in upper case is the same request.
    const upper = await cancel(deps, booking.id.toUpperCase(), k);

    expect(first.replayed).toBe(false);
    for (const replay of [again, upper]) {
      expect(replay).toEqual({ ...first, replayed: true });
    }
    const types = (await deps.store.listEvents(booking.id)).map((e) => e.type);
    expect(types).toEqual(["booked", "cancelled"]);
  });

  it("is idempotency_conflict for the same key on a different booking", async () => {
    const deps = memoryDeps();
    const one = await bookAt(deps, at("14:30"));
    const two = await bookAt(deps, at("16:00"));
    await cancel(deps, one.id, "cancel-key-0001");
    const err = await rejection(cancel(deps, two.id, "cancel-key-0001"));
    expect(err.code).toBe("idempotency_conflict");
    expect(err.details).toEqual({ idempotency_key: "cancel-key-0001", tool: "cancel" });
    expect((await getBooking(deps, "harts", { booking_id: two.id })).booking.status).toBe("confirmed");
  });

  it("keeps book and cancel keys apart: the same key can book and then cancel", async () => {
    const deps = memoryDeps();
    const k = key();
    const { booking } = await book(
      deps,
      "harts",
      { service_id: "haircut", start: at("14:30"), customer_name: "Maya", idempotency_key: k },
      "agent",
    );
    expect((await cancel(deps, booking.id, k)).replayed).toBe(false);
  });

  it("lets exactly one of two concurrent cancels win; the other is not_cancellable", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    const outcomes = await Promise.allSettled([cancel(deps, booking.id), cancel(deps, booking.id)]);

    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(FrontDeskError);
    expect((lost[0].reason as FrontDeskError).code).toBe("not_cancellable");
    expect((lost[0].reason as FrontDeskError).details).toMatchObject({ status: "cancelled" });
    const cancelled = (await deps.store.listEvents(booking.id)).filter((e) => e.type === "cancelled");
    expect(cancelled).toHaveLength(1);
  });

  it("records the history: booked by the agent, then cancelled by the agent with the deposit effect", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const booking = await bookAt(deps, at("14:30"));
    clock.set(new Date(NOW.getTime() + 3 * HOUR_MS).toISOString());
    await cancel(deps, booking.id);

    expect(await deps.store.listEvents(booking.id)).toEqual([
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "agent",
        type: "booked",
        data: { status: "confirmed", agentName: "test-agent" },
      },
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T15:00:00-05:00",
        actor: "agent",
        type: "cancelled",
        data: { from: "confirmed", to: "cancelled", depositEffect: "released", depositCollected: false },
      },
    ]);
  });
});

describe("getBooking", () => {
  it("returns the booking as book returned it", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    expect(await getBooking(deps, "harts", { booking_id: booking.id })).toEqual({ booking });
    // Ids are UUIDs: case and surrounding spaces don't matter.
    expect(await getBooking(deps, "harts", { booking_id: ` ${booking.id.toUpperCase()} ` })).toEqual({ booking });
  });

  it("is invalid_request for an empty booking_id", async () => {
    const err = await rejection(getBooking(memoryDeps(), "harts", { booking_id: "" }));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field: "booking_id" });
  });
});

describe("getPolicies", () => {
  it("returns Hart's seeded policies", async () => {
    const result = await getPolicies(memoryDeps(), "harts");
    expect(result).toEqual({
      shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
      policies: SEED.policies.harts,
    });
    expect(result.policies).toMatchObject({
      leadTimeMin: 120,
      horizonDays: 30,
      depositHorizonDays: 6,
      cancelWindowHours: 24,
      paused: false,
      phone: "+1 212-555-0142",
    });
  });

  it("shows the owner's changes", async () => {
    const { policies } = await getPolicies(memoryDeps({ policies: { paused: true, phone: null } }), "harts");
    expect(policies).toMatchObject({ paused: true, phone: null });
  });

  it("is not_found for an unknown shop", async () => {
    expect((await rejection(getPolicies(memoryDeps(), "nope"))).code).toBe("not_found");
  });
});
