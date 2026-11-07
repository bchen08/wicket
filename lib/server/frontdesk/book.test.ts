import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookInput, Slot } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import type { NewBlock } from "./catalog";
import { FrontDeskError } from "./errors";
import { book, getAvailability, type FrontDeskDeps } from "./service";
import { memoryDeps, NOW, recordingNotifier, SAT } from "./test-support";

// book() against the in-memory store with a fixed clock: Mon 9 Nov 2026, noon in New York (Hart's is
// closed on Mondays). Dana works Tue–Sat 09:00–12:00 and 12:30–17:00. Saturday 14 Nov (5 days ahead)
// starts with no bookings. Hart's rules: 2 hours' lead time, 30 days ahead (6 for a service with a
// deposit: haircut and haircut-beard; beard-trim has none).

const at = (hhmm: string) => `2026-11-14T${hhmm}:00-05:00`;
const key = () => crypto.randomUUID();
const input = (service_id: string, start: string, customer_name = "Maya", idempotency_key = key()): BookInput => ({
  service_id,
  start,
  customer_name,
  idempotency_key,
});
const haircut = (start: string, customer_name = "Maya", idempotency_key = key()) =>
  input("haircut", start, customer_name, idempotency_key);

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

const HOUR_MS = 60 * 60 * 1000;
/** Tuesday 10 Nov, a working day. */
const tuesdayAt = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00-05:00`);

async function rejection(promise: Promise<unknown>): Promise<FrontDeskError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FrontDeskError);
    return err as FrontDeskError;
  }
  throw new Error("expected a FrontDeskError");
}

async function saturdayStarts(deps: FrontDeskDeps, service_id = "haircut"): Promise<string[]> {
  const { slots } = await getAvailability(deps, "harts", { service_id, ...SAT, limit: 50 });
  return slots.map((s) => s.start);
}

/**
 * Deps whose catalog misses bookings on the first busy-time read only, as if this agent checked the
 * slot just before another agent's booking was stored. Later reads see everything.
 */
function staleOnce(deps: FrontDeskDeps): FrontDeskDeps {
  let reads = 0;
  return {
    ...deps,
    catalog: {
      ...deps.catalog,
      getBusyIntervals: async (slug, range) =>
        reads++ === 0
          ? (await deps.catalog.getBusyIntervals(slug, range)).filter((b) => b.kind === "block")
          : deps.catalog.getBusyIntervals(slug, range),
    },
  };
}

const slot = (start: string, end: string): Slot => ({
  start: at(start),
  end: at(end),
  staffId: "dana",
  display: `Sat 14 Nov, ${Number(start.slice(0, 2)) % 12 || 12}:${start.slice(3)} ${Number(start.slice(0, 2)) < 12 ? "am" : "pm"} EST`,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("book", () => {
  it("books a valid slot as a confirmed Booking, and get_availability stops offering it", async () => {
    const notifier = recordingNotifier();
    const deps = memoryDeps({ notifier });
    expect(await saturdayStarts(deps)).toContain(at("14:30"));

    const { booking, staffName, replayed } = await book(deps, "harts", haircut(at("14:30"), "  Maya Lopez  "), "claude-ai");

    expect(booking).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      shopSlug: "harts",
      serviceId: "haircut",
      serviceName: "Haircut",
      staffId: "dana",
      start: at("14:30"),
      end: at("15:00"),
      display: "Sat 14 Nov, 2:30 pm EST",
      status: "confirmed",
      customer: { displayName: "Maya Lopez", verified: false },
      agent: { name: "claude-ai" },
      depositCents: 1000,
      createdAt: "2026-11-09T12:00:00-05:00",
    });
    expect(staffName).toBe("Dana");
    expect(replayed).toBe(false);
    expect(notifier.alerts).toEqual([booking]);

    const after = await saturdayStarts(deps);
    // A 30-minute haircut at 14:30 blocks 14:15 (would run to 14:45), 14:30 and 14:45.
    for (const t of ["14:15", "14:30", "14:45"]) expect(after).not.toContain(at(t));
    for (const t of ["14:00", "15:00"]) expect(after).toContain(at(t));
  });

  it("writes one 'booked' event for the new booking", async () => {
    const deps = memoryDeps();
    const { booking } = await book(deps, "harts", haircut(at("14:30")), "claude-ai");
    expect(await deps.store.listEvents(booking.id)).toEqual([
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "agent",
        type: "booked",
        data: { status: "confirmed", agentName: "claude-ai" },
      },
    ]);
  });

  it("accepts the same instant written with another offset", async () => {
    const { booking } = await book(memoryDeps(), "harts", haircut("2026-11-14T19:30:00Z"), "agent");
    expect(booking.start).toBe(at("14:30"));
  });

  it("refuses an unknown service with invalid_request pointing at list_services", async () => {
    const err = await rejection(book(memoryDeps(), "harts", input("perm", at("10:00")), "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.nextAction).toMatch(/list_services/);
    expect(err.details).toMatchObject({ field: "service_id", valid_service_ids: ["haircut", "beard-trim", "haircut-beard"] });
  });

  it.each<[string, BookInput, string]>([
    ["a start without an offset", haircut("2026-11-14T10:00:00"), "start"],
    ["a date-only start", haircut("2026-11-14"), "start"],
    ["an empty customer name", haircut(at("10:00"), ""), "customer_name"],
    ["a customer name of only spaces", haircut(at("10:00"), "   "), "customer_name"],
    ["an 81-character customer name", haircut(at("10:00"), "x".repeat(81)), "customer_name"],
  ])("refuses %s with invalid_request and a next_action", async (_label, args, field) => {
    const err = await rejection(book(memoryDeps(), "harts", args, "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field });
    expect(err.nextAction.length).toBeGreaterThan(0);
  });

  it("accepts an 80-character customer name (the limit), after trimming", async () => {
    const name = "x".repeat(80);
    const { booking } = await book(memoryDeps(), "harts", haircut(at("10:00"), ` ${name} `), "agent");
    expect(booking.customer.displayName).toBe(name);
  });

  it("is not_found for an unknown shop", async () => {
    const err = await rejection(book(memoryDeps(), "nope", haircut(at("10:00")), "agent"));
    expect(err.code).toBe("not_found");
  });

  it("labels a booking 'unknown agent' when the agent name is blank, and caps it at 80 characters", async () => {
    const deps = memoryDeps();
    expect((await book(deps, "harts", haircut(at("09:00")), "  ")).booking.agent.name).toBe("unknown agent");
    expect((await book(deps, "harts", haircut(at("09:30")), "a".repeat(200))).booking.agent.name).toHaveLength(80);
  });

  it("still books when the notifier throws, and logs the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = memoryDeps({
      notifier: {
        async alertOwner() {
          throw new Error("SMTP is down");
        },
      },
    });

    const { booking } = await book(deps, "harts", haircut(at("11:00")), "agent");
    expect(booking.status).toBe("confirmed");
    expect(await saturdayStarts(deps)).not.toContain(at("11:00"));
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(errors.mock.calls[0][0]));
    expect(logged).toMatchObject({ event: "booking.notify_failed", id: booking.id, error: "SMTP is down" });
  });
});

describe("book: slot_taken", () => {
  it("refuses the same slot twice, offering the 3 nearest open starts as alternatives", async () => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("10:00")), "agent A");
    const err = await rejection(book(deps, "harts", haircut(at("10:00"), "Jo"), "agent B"));

    expect(err.code).toBe("slot_taken");
    expect(err.message).toBe("That time is already booked.");
    expect(err.nextAction).toBe(
      "Someone just took that time. Call get_availability again and choose another start. " +
        "Nearby open starts you can offer instead are in details.alternatives.",
    );
    // 9:30 and 10:30 are 30 minutes away; 9:15 and 10:45 are 45 minutes away, and the earlier wins the tie.
    expect(err.details).toEqual({
      start: at("10:00"),
      service_id: "haircut",
      alternatives: [slot("09:15", "09:45"), slot("09:30", "10:00"), slot("10:30", "11:00")],
    });
  });

  it("offers alternatives that are actually bookable", async () => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("10:00")), "agent A");
    const err = await rejection(
      book(deps, "harts", input("haircut-beard", at("09:45"), "Jo"), "agent B"),
    );
    expect(err.code).toBe("slot_taken");
    const alternatives = (err.details as { alternatives: Slot[] }).alternatives;
    // The 45-minute service fits at 9:00 and 9:15 (ending by 10:00) and from 10:30.
    expect(alternatives.map((s) => s.start)).toEqual([at("09:00"), at("09:15"), at("10:30")]);

    const offered = await saturdayStarts(deps, "haircut-beard");
    for (const alt of alternatives) {
      expect(offered).toContain(alt.start);
      expect(alt.staffId).toBe("dana");
    }
    const { booking } = await book(deps, "harts", input("haircut-beard", alternatives[0].start, "Jo"), "agent B");
    expect(booking.start).toBe(at("09:00"));
  });

  it("refuses an overlapping service: haircut-beard at 9:45 runs into a haircut at 10:00", async () => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("10:00")), "agent A");
    const err = await rejection(book(deps, "harts", input("haircut-beard", at("09:45"), "Jo"), "agent B"));
    expect(err.code).toBe("slot_taken");
    // Back to back is fine: a 15-minute beard trim at 9:45 ends exactly at 10:00.
    const { booking } = await book(deps, "harts", input("beard-trim", at("09:45"), "Jo"), "B");
    expect(booking.end).toBe(at("10:00"));
  });

  it("lets the store have the final word in a race, with alternatives from fresh busy time", async () => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("10:00")), "agent A");
    // Agent B's check doesn't see A's booking yet; the store refuses the overlap.
    const err = await rejection(
      book(staleOnce(deps), "harts", input("haircut-beard", at("09:45"), "Jo"), "agent B"),
    );
    expect(err.code).toBe("slot_taken");
    expect(err.nextAction).toMatch(/^Someone just took that time\. Call get_availability again/);
    const alternatives = (err.details as { alternatives: Slot[] }).alternatives;
    // Computed after the refusal, so none of them overlaps A's 10:00–10:30 haircut.
    expect(alternatives.map((s) => s.start)).toEqual([at("09:00"), at("09:15"), at("10:30")]);
    expect((await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).length).toBe(1);
  });

  it("has no alternatives (and doesn't mention them) when nothing nearby is free", async () => {
    // Dana is blocked from Friday until 14:30 Saturday and from 15:00 Saturday on; Sunday is closed.
    const initialBlocks: NewBlock[] = [
      { staffId: "dana", start: new Date("2026-11-13T00:00:00-05:00"), end: new Date(at("14:30")), reason: "Away" },
      { staffId: "dana", start: new Date(at("15:00")), end: new Date("2026-11-16T00:00:00-05:00"), reason: "Away" },
    ];
    const deps = memoryDeps({ initialBlocks });
    await book(deps, "harts", haircut(at("14:30")), "agent A");
    const err = await rejection(book(deps, "harts", haircut(at("14:30"), "Jo"), "agent B"));
    expect(err.code).toBe("slot_taken");
    expect(err.nextAction).toBe("Someone just took that time. Call get_availability again and choose another start.");
    expect(err.details).toMatchObject({ alternatives: [] });
  });
});

describe("book: a start that isn't bookable gets the most specific code", () => {
  it("is too_soon for a past start, with the earliest allowed start", async () => {
    const err = await rejection(book(memoryDeps(), "harts", haircut("2026-11-07T09:00:00-05:00"), "agent"));
    expect(err.code).toBe("too_soon");
    expect(err.message).toBe("Hart's Barbers needs at least 2 hours notice; the earliest start is Mon 9 Nov, 2:00 pm EST.");
    expect(err.nextAction).toBe("Pick a later time: call get_availability from details.earliest.");
    expect(err.details).toEqual({
      earliest: "2026-11-09T14:00:00-05:00",
      lead_time_min: 120,
      start: "2026-11-07T09:00:00-05:00",
    });
  });

  it("is too_soon for a start 1 hour from now on a working day", async () => {
    const deps = memoryDeps({ clock: fixedClock(tuesdayAt("09:00")) });
    const err = await rejection(book(deps, "harts", haircut("2026-11-10T10:00:00-05:00"), "agent"));
    expect(err.code).toBe("too_soon");
    expect(err.details).toMatchObject({ earliest: "2026-11-10T11:00:00-05:00", lead_time_min: 120 });
  });

  it("rounds details.earliest up to the 15-minute grid, and that start can be booked", async () => {
    const deps = memoryDeps({ clock: fixedClock(tuesdayAt("09:07")) });
    const err = await rejection(book(deps, "harts", haircut("2026-11-10T10:00:00-05:00"), "agent"));
    expect(err.code).toBe("too_soon");
    expect(err.message).toBe("Hart's Barbers needs at least 2 hours notice; the earliest start is Tue 10 Nov, 11:15 am EST.");
    const earliest = (err.details as { earliest: string }).earliest;
    expect(earliest).toBe("2026-11-10T11:15:00-05:00"); // 09:07 + 2 h = 11:07, rounded up

    const { slots } = await getAvailability(deps, "harts", {
      service_id: "haircut",
      from: earliest,
      to: "2026-11-11T00:00:00-05:00",
    });
    expect(slots[0].start).toBe(earliest);
    expect((await book(deps, "harts", haircut(earliest), "agent")).booking.start).toBe(earliest);
  });

  it("is too_far for a haircut 7 days out (beyond the 6-day deposit horizon), but not for a beard trim", async () => {
    const deps = memoryDeps({ clock: fixedClock(tuesdayAt("09:00")) });
    const start = "2026-11-17T09:00:00-05:00"; // Tuesday, a working day
    const err = await rejection(book(deps, "harts", haircut(start), "agent"));
    expect(err.code).toBe("too_far");
    expect(err.message).toBe("Hart's Barbers takes bookings for Haircut up to 6 days ahead.");
    expect(err.nextAction).toBe("Pick an earlier time, before details.latest.");
    expect(err.details).toEqual({ latest: "2026-11-16T09:00:00-05:00", horizon_days: 6, start });

    const { booking } = await book(deps, "harts", input("beard-trim", start), "agent");
    expect(booking.start).toBe(start);
  });

  it("is too_far for a beard trim 31 days out (beyond the 30-day horizon); the horizon itself is excluded", async () => {
    const deps = memoryDeps({ clock: fixedClock(tuesdayAt("09:00")) });
    for (const start of ["2026-12-11T09:00:00-05:00", "2026-12-10T09:00:00-05:00"]) {
      const err = await rejection(book(deps, "harts", input("beard-trim", start), "agent"));
      expect(err.code).toBe("too_far");
      expect(err.message).toBe("Hart's Barbers takes bookings for Beard trim up to 30 days ahead.");
      expect(err.details).toEqual({ latest: "2026-12-10T09:00:00-05:00", horizon_days: 30, start });
    }
    const { booking } = await book(deps, "harts", input("beard-trim", "2026-12-09T09:00:00-05:00"), "agent");
    expect(booking.status).toBe("confirmed");
  });

  it("is paused when the owner paused bookings, with the shop's phone", async () => {
    const err = await rejection(book(memoryDeps({ policies: { paused: true } }), "harts", haircut(at("14:30")), "agent"));
    expect(err.code).toBe("paused");
    expect(err.message).toBe("Hart's Barbers isn't taking bookings right now.");
    expect(err.nextAction).toBe("Tell the person to call the shop at +1 212-555-0142.");
    expect(err.details).toEqual({ phone: "+1 212-555-0142" });
  });

  it("is paused with phone null when the shop has no phone", async () => {
    const deps = memoryDeps({ policies: { paused: true, phone: null } });
    const err = await rejection(book(deps, "harts", haircut(at("14:30")), "agent"));
    expect(err.code).toBe("paused");
    expect(err.nextAction).toBe("Tell the person to call the shop.");
    expect(err.details).toEqual({ phone: null });
  });

  const dentist: NewBlock = {
    staffId: "dana",
    start: new Date(at("13:00")),
    end: new Date(at("15:00")),
    reason: "Dentist",
  };

  it.each<[string, string]>([
    ["an off-grid start (10:05)", at("10:05")],
    ["a start during lunch (12:00)", at("12:00")],
    ["a start that would run into lunch (11:45)", at("11:45")],
    ["a start before opening (08:30)", at("08:30")],
    ["a start that would run past closing (16:45)", at("16:45")],
    ["a day the shop is closed (Sunday)", "2026-11-15T10:00:00-05:00"],
    ["a start inside a blocked time (13:30)", at("13:30")],
    ["a start that would run into a blocked time (12:45)", at("12:45")],
  ])("is outside_hours for %s", async (_label, start) => {
    const err = await rejection(book(memoryDeps({ initialBlocks: [dentist] }), "harts", haircut(start), "agent"));
    expect(err.code).toBe("outside_hours");
    expect(err.message).toBe("That isn't a bookable time for Haircut.");
    expect(err.nextAction).toBe("Call get_availability and choose one of the returned starts.");
    expect(err.details).toEqual({ field: "start", value: start, service_id: "haircut" });
  });

  it("checks the pause before the lead time and the horizon", async () => {
    const deps = memoryDeps({ policies: { paused: true } });
    expect((await rejection(book(deps, "harts", haircut("2026-11-07T09:00:00-05:00"), "agent"))).code).toBe("paused");
    expect((await rejection(book(deps, "harts", haircut("2026-12-01T10:00:00-05:00"), "agent"))).code).toBe("paused");
  });
});

describe("book: idempotency", () => {
  it("returns the same booking for the same key and arguments, without booking or alerting twice", async () => {
    const notifier = recordingNotifier();
    const deps = memoryDeps({ notifier });
    const args = haircut(at("14:30"));

    const first = await book(deps, "harts", args, "agent");
    const again = await book(deps, "harts", args, "agent");

    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.booking).toEqual(first.booking);
    expect(again.staffName).toBe("Dana");
    expect(await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toHaveLength(1);
    expect((await deps.store.listEvents(first.booking.id)).map((e) => e.type)).toEqual(["booked"]);
    expect(notifier.alerts).toHaveLength(1);
  });

  it("treats the same instant with another offset, and the same name with extra spaces, as the same request", async () => {
    const deps = memoryDeps();
    const k = key();
    const first = await book(deps, "harts", haircut(at("14:30"), "Maya", k), "agent");
    const again = await book(deps, "harts", haircut("2026-11-14T19:30:00Z", "  Maya ", k), "agent");
    expect(again.replayed).toBe(true);
    expect(again.booking.id).toBe(first.booking.id);
  });

  it.each<[string, BookInput]>([
    ["another start", haircut(at("15:30"), "Maya", "reused-key-0001")],
    ["another customer name", haircut(at("14:30"), "Jo", "reused-key-0001")],
    ["another service", input("beard-trim", at("14:30"), "Maya", "reused-key-0001")],
  ])("is idempotency_conflict when a used key comes back with %s", async (_label, second) => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("14:30"), "Maya", "reused-key-0001"), "agent");
    const err = await rejection(book(deps, "harts", second, "agent"));
    expect(err.code).toBe("idempotency_conflict");
    expect(err.details).toEqual({ idempotency_key: "reused-key-0001", tool: "book" });
    expect(err.nextAction).toMatch(/new idempotency_key/);
  });

  it("doesn't remember a failed call: a corrected retry with the same key books", async () => {
    const deps = memoryDeps();
    const k = key();
    expect((await rejection(book(deps, "harts", haircut("2026-11-09T13:00:00-05:00", "Maya", k), "agent"))).code).toBe(
      "too_soon",
    );
    const retry = await book(deps, "harts", haircut(at("14:30"), "Maya", k), "agent");
    expect(retry.replayed).toBe(false);
    expect(retry.booking.start).toBe(at("14:30"));
    // From now on the key belongs to the successful request.
    expect((await book(deps, "harts", haircut(at("14:30"), "Maya", k), "agent")).replayed).toBe(true);
  });

  it("books once when two calls with the same key arrive together", async () => {
    const notifier = recordingNotifier();
    const deps = memoryDeps({ notifier });
    const args = haircut(at("14:30"));
    const [a, b] = await Promise.all([book(deps, "harts", args, "agent"), book(deps, "harts", args, "agent")]);
    expect(a.booking.id).toBe(b.booking.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(notifier.alerts).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ["a 7-character key", "1234567"],
    ["a 129-character key", "k".repeat(129)],
    ["a key with a space", "my booking key"],
    ["a key outside visible ASCII", "clé-de-réservation"],
    ["a numeric key", 12345678],
    ["a missing key", undefined],
  ])("refuses %s with invalid_request naming idempotency_key", async (_label, idempotency_key) => {
    const args = { service_id: "haircut", start: at("14:30"), customer_name: "Maya", idempotency_key } as unknown as BookInput;
    const err = await rejection(book(memoryDeps(), "harts", args, "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toEqual({ field: "idempotency_key", value: idempotency_key ?? null });
    expect(err.nextAction).toBe(
      "Send a fresh UUID as idempotency_key (8–128 characters, no spaces). Reuse it only to retry this same call.",
    );
  });

  it.each([["8", "k".repeat(8)], ["128", "k".repeat(128)]])("accepts a %s-character key", async (_n, k) => {
    const { booking } = await book(memoryDeps(), "harts", haircut(at("14:30"), "Maya", k), "agent");
    expect(booking.status).toBe("confirmed");
  });

  it("lets a key be reused for a new request after 24 hours", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const k = key();
    const first = await book(deps, "harts", haircut(at("14:30"), "Maya", k), "agent");

    clock.advance(23 * HOUR_MS);
    expect((await rejection(book(deps, "harts", haircut(at("15:30"), "Maya", k), "agent"))).code).toBe(
      "idempotency_conflict",
    );

    clock.advance(2 * HOUR_MS); // 25 hours after the first call
    const later = await book(deps, "harts", haircut(at("15:30"), "Maya", k), "agent");
    expect(later.replayed).toBe(false);
    expect(later.booking.id).not.toBe(first.booking.id);
    expect(later.booking.start).toBe(at("15:30"));
  });
});
