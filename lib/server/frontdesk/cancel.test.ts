import { describe, expect, it } from "vitest";
import type { Booking, CancelInput } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { declineBooking } from "../consent/approvals";
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
import { approvalToken, approveAsCustomer, memoryDeps, NOW, SAT, withCatalog } from "./test-support";

// The agent's cancel, get_booking and get_policies use cases against the in-memory store. "Now" is
// Mon 9 Nov 2026, noon in New York. Hart's cancel window is 24 hours; haircut has a $10 deposit,
// beard-trim none. book places a 10-minute hold; the cancellation policy applies once the person has
// approved it (confirmedAt), while a hold can be cancelled any time.

const at = (hhmm: string) => `2026-11-14T${hhmm}:00-05:00`;
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

/** book's result: a hold awaiting approval, with its approval link. */
async function holdAt(deps: FrontDeskDeps, start: string, service_id = "haircut"): Promise<Booking> {
  const { booking } = await book(
    deps,
    "harts",
    { service_id, start, customer_name: "Maya" },
    "test-agent",
  );
  return booking;
}

/** The booking without its approval link, as every read after book shows it. */
function withoutLink(booking: Booking): Booking {
  const rest = { ...booking };
  delete rest.approval;
  return rest;
}

/** A hold awaiting approval, as reads show it (no link). */
async function bookAt(deps: FrontDeskDeps, start: string, service_id = "haircut"): Promise<Booking> {
  return withoutLink(await holdAt(deps, start, service_id));
}

let phoneSeq = 0;
/** A different phone number for each approval. */
const nextPhone = () => `+1401555${String(1000 + (phoneSeq++ % 9000))}`;

/** A booking the person approved: confirmed, with a verified customer. */
async function confirmedAt(deps: FrontDeskDeps, start: string, service_id = "haircut"): Promise<Booking> {
  return approveAsCustomer(deps, await holdAt(deps, start, service_id), nextPhone());
}

const cancel = (deps: FrontDeskDeps, booking_id: string) => cancelBooking(deps, "harts", { booking_id });

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
    const booking = await confirmedAt(deps, at("14:30"));
    const starts = async () =>
      (await getAvailability(deps, "harts", { service_id: "haircut", ...SAT, limit: 50 })).slots.map((s) => s.start);
    expect(await starts()).not.toContain(at("14:30"));

    const result = await cancel(deps, booking.id);

    expect(result).toEqual({
      booking: { ...booking, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    });
    expect(await starts()).toContain(at("14:30"));
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("cancelled");
  });

  it("captures the deposit when cancelling inside 24 hours (but before the start)", async () => {
    const deps = memoryDeps();
    const booking = await confirmedAt(deps, "2026-11-10T10:00:00-05:00"); // 22 hours ahead
    const result = await cancel(deps, booking.id);
    expect(result.booking.status).toBe("cancelled");
    expect(result.depositEffect).toBe("captured");
    expect(result.depositCollected).toBe(false);
  });

  it("releases at exactly 24 hours ahead and captures a minute later", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const onTime = await confirmedAt(deps, at("14:30"));
    const late = await confirmedAt(deps, at("16:00"));
    clock.set("2026-11-13T14:30:00-05:00");
    expect((await cancel(deps, onTime.id)).depositEffect).toBe("released");
    clock.set("2026-11-13T16:01:00-05:00");
    expect((await cancel(deps, late.id)).depositEffect).toBe("captured");
  });

  it("is not_cancellable once the appointment has started", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const booking = await confirmedAt(deps, at("14:30"));
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
    const early = await confirmedAt(deps, at("14:30"), "beard-trim");
    const soon = await confirmedAt(deps, "2026-11-10T10:00:00-05:00", "beard-trim");
    expect((await cancel(deps, early.id)).depositEffect).toBe("none");
    expect((await cancel(deps, soon.id)).depositEffect).toBe("none");
  });

  it("cancels a hold awaiting approval any time, even inside the window: released, and the slot is free", async () => {
    const deps = memoryDeps();
    const soon = await bookAt(deps, "2026-11-10T10:00:00-05:00"); // 22 hours ahead: inside the window
    const result = await cancel(deps, soon.id);
    expect(result).toEqual({
      booking: { ...soon, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    });
    const trim = await bookAt(deps, at("14:30"), "beard-trim");
    expect((await cancel(deps, trim.id)).depositEffect).toBe("none");
    const starts = (
      await getAvailability(deps, "harts", { service_id: "haircut", from: "2026-11-10T00:00:00-05:00", to: "2026-11-11T00:00:00-05:00" })
    ).slots.map((s) => s.start);
    expect(starts).toContain("2026-11-10T10:00:00-05:00");
  });

  it("cancels a hold even after its start, like an awaiting-deposit booking", async () => {
    // With no lead time a hold can be for right now; it's still the agent's to drop.
    const clock = mutableClock(new Date("2026-11-10T09:55:00-05:00"));
    const deps = memoryDeps({ clock, policies: { leadTimeMin: 0 } });
    const booking = await bookAt(deps, "2026-11-10T10:00:00-05:00");
    clock.set("2026-11-10T10:01:00-05:00"); // started, hold still on until 10:05
    expect((await cancel(deps, booking.id)).booking.status).toBe("cancelled");
  });

  it("is not_cancellable for a hold that ran out: it reads as expired", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const booking = await bookAt(deps, at("14:30"));
    clock.set(new Date(NOW.getTime() + 10 * 60_000).toISOString()); // the hold's deadline
    const err = await rejection(cancel(deps, booking.id));
    expect(err.code).toBe("not_cancellable");
    expect(err.message).toBe("This booking has already expired.");
    expect(err.details).toMatchObject({ status: "expired" });
    expect((await deps.store.listEvents(booking.id)).map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
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
    const viaCancel = await rejection(cancelBooking(deps, "elsewhere", { booking_id: booking.id }));
    const viaGet = await rejection(getBooking(deps, "elsewhere", { booking_id: booking.id }));
    expect(viaCancel.code).toBe("booking_not_found");
    expect(viaGet.code).toBe("booking_not_found");
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("awaiting_approval");
  });

  it("is not_found for an unknown shop", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    expect((await rejection(cancelBooking(deps, "nope", { booking_id: booking.id }))).code).toBe(
      "not_found",
    );
    expect((await rejection(getBooking(deps, "nope", { booking_id: booking.id }))).code).toBe("not_found");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a missing booking_id", {}, "booking_id"],
    ["an empty booking_id", { booking_id: "  " }, "booking_id"],
    ["a numeric booking_id", { booking_id: 7 }, "booking_id"],
  ])("is invalid_request for %s", async (_label, args, field) => {
    const err = await rejection(cancelBooking(memoryDeps(), "harts", args as unknown as CancelInput));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field });
  });

  it("cancelling twice is harmless: the second is not_cancellable, with still exactly one cancelled event", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    const first = await cancel(deps, booking.id);
    expect(first.booking.status).toBe("cancelled");
    // The same booking id in upper case is the same booking.
    for (const id of [booking.id, booking.id.toUpperCase()]) {
      const err = await rejection(cancel(deps, id));
      expect(err.code).toBe("not_cancellable");
      expect(err.details).toMatchObject({ status: "cancelled" });
    }
    const types = (await deps.store.listEvents(booking.id)).map((e) => e.type);
    expect(types).toEqual(["booked", "cancelled"]);
  });

  it("ignores an idempotency_key an older agent still sends", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    const args = { booking_id: booking.id, idempotency_key: "cancel-key-0001" } as unknown as CancelInput;
    expect((await cancelBooking(deps, "harts", args)).booking.status).toBe("cancelled");
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

  it("records the history: booked by the agent, approved by the person, then cancelled by the agent with the deposit effect", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const booking = await holdAt(deps, at("14:30"));
    await approveAsCustomer(deps, booking, "+14015550123");
    clock.set(new Date(NOW.getTime() + 3 * HOUR_MS).toISOString());
    await cancel(deps, booking.id);

    expect(await deps.store.listEvents(booking.id)).toEqual([
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "agent",
        type: "booked",
        data: { status: "awaiting_approval", agentName: "test-agent" },
      },
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "customer",
        type: "approved",
        data: { from: "awaiting_approval", to: "confirmed", depositEffect: "none", depositCollected: false, phoneLast4: "0123" },
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

  it("records a hold's cancellation from awaiting approval", async () => {
    const deps = memoryDeps();
    const booking = await bookAt(deps, at("14:30"));
    await cancel(deps, booking.id);
    const events = await deps.store.listEvents(booking.id);
    expect(events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["cancelled", "agent"],
    ]);
    expect(events[1].data).toEqual({ from: "awaiting_approval", to: "cancelled", depositEffect: "released", depositCollected: false });
  });
});

describe("getBooking", () => {
  it("returns the booking as book returned it, without the approval link", async () => {
    const deps = memoryDeps();
    const held = await holdAt(deps, at("14:30"));
    const booking = withoutLink(held);
    expect(held.approval).toBeDefined();
    expect(await getBooking(deps, "harts", { booking_id: booking.id })).toEqual({ booking, declined: false });
    // Ids are UUIDs: case and surrounding spaces don't matter.
    expect(await getBooking(deps, "harts", { booking_id: ` ${booking.id.toUpperCase()} ` })).toEqual({ booking, declined: false });
  });

  it("reports what the person did: approved → confirmed and verified, declined → cancelled, lapsed → expired", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const approved = await holdAt(deps, at("10:00"));
    const declined = await holdAt(deps, at("11:00"));
    const cancelledByAgent = await bookAt(deps, at("13:00"));
    const lapsed = await bookAt(deps, at("14:00"));

    await approveAsCustomer(deps, approved, "+14015550123");
    await declineBooking(deps, approvalToken(declined));
    await cancel(deps, cancelledByAgent.id);
    clock.set(new Date(NOW.getTime() + 10 * 60_000).toISOString());

    const read = (id: string) => getBooking(deps, "harts", { booking_id: id });
    expect(await read(approved.id)).toMatchObject({
      booking: { status: "confirmed", customer: { displayName: "Maya", verified: true, phoneLast4: "0123" } },
      declined: false,
    });
    expect(await read(declined.id)).toMatchObject({ booking: { status: "cancelled", customer: { verified: false } }, declined: true });
    expect(await read(cancelledByAgent.id)).toMatchObject({ booking: { status: "cancelled" }, declined: false });
    expect(await read(lapsed.id)).toMatchObject({ booking: { status: "expired" }, declined: false });
    // The read itself recorded the lapse, once.
    await read(lapsed.id);
    expect((await deps.store.listEvents(lapsed.id)).map((e) => e.type)).toEqual(["booked", "expired"]);
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
