import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BookInput, Mandate, Slot } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import type { NewBlock, TimeRange } from "./catalog";
import { FrontDeskError } from "./errors";
import { SEED, type MemoryStore } from "./memory-store";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "./postgres-store";
import { book, getAvailability, getBooking, listServices, type FrontDeskDeps } from "./service";
import { approveAsCustomer, customerOf, memoryDeps, NOW, PHONE_E164, recordingNotifier, SAT, withBaseUrl, withCatalog } from "./test-support";

// book() against the in-memory store with a fixed clock: Mon 9 Nov 2026, noon in New York (Hart's is
// closed on Mondays). Dana works Tue–Sat 09:00–12:00 and 12:30–17:00. Saturday 14 Nov (5 days ahead)
// starts with no bookings. Hart's rules: 2 hours' lead time, 30 days ahead (6 for a service with a
// deposit: haircut and haircut-beard; beard-trim has none). book places a hold awaiting approval for
// 10 minutes (until 12:10 pm on Monday) and returns the approval link.

const at = (hhmm: string) => `2026-11-14T${hhmm}:00-05:00`;
const input = (service_id: string, start: string, customer_name = "Maya"): BookInput => ({ service_id, start, customer_name });
const haircut = (start: string, customer_name = "Maya") => input("haircut", start, customer_name);

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
  return withCatalog(deps, (catalog) => ({
    getBusyIntervals: async (slug, range) =>
      reads++ === 0
        ? (await catalog.getBusyIntervals(slug, range)).filter((b) => b.kind === "block")
        : catalog.getBusyIntervals(slug, range),
  }));
}

/** `deps` that record the range of every busy-time read. */
function recordingBusy(deps: FrontDeskDeps): { deps: FrontDeskDeps; ranges: TimeRange[] } {
  const ranges: TimeRange[] = [];
  return {
    ranges,
    deps: withCatalog(deps, (catalog) => ({
      getBusyIntervals: (slug, range) => {
        ranges.push(range);
        return catalog.getBusyIntervals(slug, range);
      },
    })),
  };
}

/**
 * Deps for a Hart's where more barbers work Dana's exact hours. Their ids sort after "dana", so a
 * check picks Dana first. The memory store mirrors the staff foreign key, so they go into the seed it
 * copies, only while the store is created.
 */
function withBarbers(...names: string[]): FrontDeskDeps {
  const added = names.map((name) => ({ ...structuredClone(SEED.staff[0]), id: name.toLowerCase(), name }));
  SEED.staff.push(...added);
  try {
    return memoryDeps();
  } finally {
    SEED.staff.splice(-added.length, added.length);
  }
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

/** The approval link book returns: deps.baseUrl (localhost in tests) + /approve/ + a 43-character base64url token. */
const APPROVAL_URL = /^http:\/\/localhost:3000\/approve\/[A-Za-z0-9_-]{43}$/;
/** NOW + 10 minutes, in New York: when a hold placed at NOW lapses. */
const HOLD_EXPIRES = "2026-11-09T12:10:00-05:00";
const MANDATE_NEXT = "Ask the person to widen their limit, or choose a different service or time.";

describe("book", () => {
  it("holds a valid slot awaiting approval, with an approval link, and get_availability stops offering it", async () => {
    const notifier = recordingNotifier();
    const deps = memoryDeps({ notifier });
    expect(await saturdayStarts(deps)).toContain(at("14:30"));

    const { booking, staffName } = await book(deps, "harts", haircut(at("14:30"), "  Maya Lopez  "), "claude-ai");

    expect(booking).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      shopSlug: "harts",
      serviceId: "haircut",
      serviceName: "Haircut",
      staffId: "dana",
      start: at("14:30"),
      end: at("15:00"),
      display: "Sat 14 Nov, 2:30 pm EST",
      status: "awaiting_approval",
      customer: customerOf("Maya Lopez", false),
      agent: { name: "claude-ai" },
      depositCents: 1000,
      deposit: { amountCents: 1000, state: "none" },
      createdAt: "2026-11-09T12:00:00-05:00",
      approval: { url: expect.stringMatching(APPROVAL_URL), expiresAt: HOLD_EXPIRES },
    });
    expect(staffName).toBe("Dana");
    // The owner hears about it only once the person approves.
    expect(notifier.alerts).toEqual([]);
    const confirmed = await approveAsCustomer(deps, booking);
    expect(notifier.alerts).toEqual([confirmed]);
    expect(confirmed).toMatchObject({ status: "confirmed", customer: { approved: true, phone: PHONE_E164 } });

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
        data: { status: "awaiting_approval", agentName: "claude-ai" },
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
    ["a customer name with a NUL character", haircut(at("10:00"), "Ma\u0000ya"), "customer_name"],
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

  it("strips NUL and other control characters from the agent name (Postgres text can't hold U+0000)", async () => {
    const deps = memoryDeps();
    expect((await book(deps, "harts", haircut(at("09:00")), "claude\u0000-ai\t\n")).booking.agent.name).toBe("claude-ai");
    expect((await book(deps, "harts", haircut(at("09:30")), "\u0000\u001f")).booking.agent.name).toBe("unknown agent");
  });

  it("still approves when the notifier throws, and logs the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = memoryDeps({
      notifier: {
        async alertOwner() {
          throw new Error("SMTP is down");
        },
      },
    });

    const { booking: held } = await book(deps, "harts", haircut(at("11:00")), "agent");
    expect(errors).not.toHaveBeenCalled(); // book itself never notifies
    const booking = await approveAsCustomer(deps, held);
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

  it("books another staff member free at the same start when the race for the first is lost", async () => {
    const notifier = recordingNotifier();
    const deps = { ...withBarbers("Sam"), notifier };
    const winner = await book(deps, "harts", haircut(at("14:30")), "agent A");
    expect(winner.booking.staffId).toBe("dana");

    // Agent B's check doesn't see A's booking, so it picks Dana too and the store refuses. B reads busy
    // time again, sees Sam is free at exactly 14:30, and books Sam instead of failing with slot_taken.
    const loser = await book(staleOnce(deps), "harts", haircut(at("14:30"), "Jo"), "agent B");
    expect(loser.booking).toMatchObject({ staffId: "sam", start: at("14:30"), status: "awaiting_approval" });
    expect(loser.booking.approval?.url).toMatch(APPROVAL_URL);
    expect(loser.booking.customer.displayName).toBe("Jo");
    expect(loser.staffName).toBe("Sam");

    const stored = await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) });
    expect(stored.map((b) => b.staffId).sort()).toEqual(["dana", "sam"]);
    expect(notifier.alerts).toEqual([]); // holds don't alert the owner
    // Each hold has its own link, and both can be approved.
    expect(loser.booking.approval?.url).not.toBe(winner.booking.approval?.url);
    await approveAsCustomer(deps, winner.booking, "+14015550101");
    await approveAsCustomer(deps, loser.booking, "+14015550102");
    expect(notifier.alerts.map((b) => b.id)).toEqual([winner.booking.id, loser.booking.id]);
  });

  it("is slot_taken after one retry, and keeps the start in the alternatives while someone is still free then", async () => {
    const deps = withBarbers("Kim", "Sam");
    expect((await book(deps, "harts", haircut(at("14:30")), "agent A")).booking.staffId).toBe("dana");
    expect((await book(deps, "harts", haircut(at("14:30"), "Lee"), "agent B")).booking.staffId).toBe("kim");

    // Agent C's first read misses both bookings (it picks Dana), its second misses Kim's (it retries
    // with Kim). Both inserts lose; the third read sees everything, and Sam is still free at 14:30.
    let reads = 0;
    const racing = withCatalog(deps, (catalog) => ({
      getBusyIntervals: async (slug, range) => {
        const busy = await catalog.getBusyIntervals(slug, range);
        const read = reads++;
        if (read === 0) return busy.filter((b) => b.kind === "block");
        if (read === 1) return busy.filter((b) => b.staffId !== "kim");
        return busy;
      },
    }));
    const err = await rejection(book(racing, "harts", haircut(at("14:30"), "Jo"), "agent C"));
    expect(err.code).toBe("slot_taken");
    expect(reads).toBe(3);
    const alternatives = (err.details as { alternatives: Slot[] }).alternatives;
    expect(alternatives.map((s) => [s.start, s.staffId])).toEqual([
      [at("14:15"), "sam"],
      [at("14:30"), "sam"],
      [at("14:45"), "sam"],
    ]);
    expect(await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toHaveLength(2);
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
    expect(booking.status).toBe("awaiting_approval");
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

  it.each<[string, string, { paused?: boolean }]>([
    ["too_far", "9999-12-31T15:00:00Z", {}],
    ["too_soon", "0001-01-01T15:00:00Z", {}],
    ["paused", at("14:30"), { paused: true }],
  ])("is %s for %s without reading busy time", async (code, start, policies) => {
    const { deps, ranges } = recordingBusy(memoryDeps({ policies }));
    const err = await rejection(book(deps, "harts", haircut(start), "agent"));
    expect(err.code).toBe(code);
    if (code !== "paused") expect(err.details).toMatchObject({ start });
    expect(ranges).toEqual([]);
  });

  it("checks the pause before the lead time and the horizon", async () => {
    const deps = memoryDeps({ policies: { paused: true } });
    expect((await rejection(book(deps, "harts", haircut("2026-11-07T09:00:00-05:00"), "agent"))).code).toBe("paused");
    expect((await rejection(book(deps, "harts", haircut("2026-12-01T10:00:00-05:00"), "agent"))).code).toBe("paused");
  });
});

describe("book: a repeated call", () => {
  it("calling twice for the same time doesn't double-book: the second is slot_taken while the hold is on", async () => {
    const notifier = recordingNotifier();
    const deps = memoryDeps({ notifier });
    const args = haircut(at("14:30"));

    const first = await book(deps, "harts", args, "agent");
    const err = await rejection(book(deps, "harts", args, "agent"));
    expect(err.code).toBe("slot_taken");
    expect(await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toHaveLength(1);
    expect((await deps.store.listEvents(first.booking.id)).map((e) => e.type)).toEqual(["booked"]);
    expect((deps.store as MemoryStore).consentRows().approvals).toHaveLength(1);
    expect(notifier.alerts).toHaveLength(0);
  });

  it("two calls for the same time at once: one hold, one slot_taken", async () => {
    const deps = memoryDeps();
    const args = haircut(at("14:30"));
    const results = await Promise.allSettled([book(deps, "harts", args, "agent"), book(deps, "harts", args, "agent")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as FrontDeskError;
    expect(reason.code).toBe("slot_taken");
    expect(await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toHaveLength(1);
  });

  it("each hold gets its own approval link", async () => {
    const deps = memoryDeps();
    const a = await book(deps, "harts", haircut(at("14:30")), "agent");
    const b = await book(deps, "harts", haircut(at("15:30")), "agent");
    expect(a.booking.approval?.url).toMatch(APPROVAL_URL);
    expect(b.booking.approval?.url).toMatch(APPROVAL_URL);
    expect(a.booking.approval?.url).not.toBe(b.booking.approval?.url);
  });

  it("ignores an argument it doesn't know, e.g. the retry key Ring 1a agents still send", async () => {
    const deps = memoryDeps();
    const args = { ...haircut(at("14:30")), retry_key: "old-client-key-0001" } as unknown as BookInput;
    const { booking } = await book(deps, "harts", args, "agent");
    expect(booking.status).toBe("awaiting_approval");
  });
});

// ---- Ring 1b: the hold, its lapse, and the mandate ----

describe("book: the hold", () => {
  it("is held until NOW + 10 minutes; another agent booking the same slot meanwhile gets slot_taken", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const first = await book(deps, "harts", haircut(at("14:30")), "agent A");
    expect(first.booking.status).toBe("awaiting_approval");
    expect(first.booking.approval).toEqual({ url: expect.stringMatching(APPROVAL_URL), expiresAt: HOLD_EXPIRES });
    expect(await saturdayStarts(deps)).not.toContain(at("14:30"));

    for (const elapsed of [0, 10 * 60_000 - 1]) {
      clock.advance(elapsed);
      const err = await rejection(book(deps, "harts", haircut(at("14:30"), "Jo"), "agent B"));
      expect(err.code).toBe("slot_taken");
    }
  });

  it("frees the slot once the hold lapses: availability offers it without writing, and a new book succeeds", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const first = await book(deps, "harts", haircut(at("14:30")), "agent A");

    clock.advance(10 * 60_000); // exactly the deadline
    expect(await saturdayStarts(deps)).toContain(at("14:30"));
    // Reading availability wrote nothing: the hold is still stored as it was.
    expect((await deps.store.getBooking(first.booking.id))?.status).toBe("awaiting_approval");
    expect((await deps.store.listEvents(first.booking.id)).map((e) => e.type)).toEqual(["booked"]);

    const second = await book(deps, "harts", haircut(at("14:30"), "Jo"), "agent B");
    expect(second.booking).toMatchObject({ status: "awaiting_approval", staffId: "dana", start: at("14:30") });
    expect(second.booking.approval?.expiresAt).toBe("2026-11-09T12:20:00-05:00");

    // book expired the stale hold in its own transaction, with an event by the system.
    expect((await deps.store.getBooking(first.booking.id))?.status).toBe("expired");
    const events = await deps.store.listEvents(first.booking.id);
    expect(events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
    expect(events[1].data).toEqual({ from: "awaiting_approval", to: "expired", depositEffect: "released", depositCollected: false });
    expect((await getBooking(deps, "harts", { booking_id: first.booking.id })).booking.status).toBe("expired");
  });

  it("offers a lapsed hold's start as an alternative to a taken neighbour", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const lapsing = await book(deps, "harts", haircut(at("14:00")), "agent A");
    clock.advance(5 * 60_000);
    await book(deps, "harts", haircut(at("14:30")), "agent B"); // still held at the end
    clock.advance(5 * 60_000); // the 14:00 hold lapses

    const err = await rejection(book(deps, "harts", haircut(at("14:30"), "Jo"), "agent C"));
    expect(err.code).toBe("slot_taken");
    expect((err.details?.alternatives as Slot[]).map((s) => s.start)).toContain(at("14:00"));
    expect((await deps.store.getBooking(lapsing.booking.id))?.status).toBe("expired");
  });

  it("doesn't free a slot the person approved, even after the hold's deadline", async () => {
    const clock = mutableClock();
    const deps = memoryDeps({ clock });
    const first = await book(deps, "harts", haircut(at("14:30")), "agent A");
    await approveAsCustomer(deps, first.booking);
    clock.advance(60 * 60_000);
    expect(await saturdayStarts(deps)).not.toContain(at("14:30"));
    expect((await rejection(book(deps, "harts", haircut(at("14:30"), "Jo"), "agent B"))).code).toBe("slot_taken");
  });
});

describe("book: mandate", () => {
  // haircut: $35.00, $10.00 deposit, 30 minutes. Booked at 14:30–15:00 on Saturday.
  const withMandate = (mandate: unknown, start = at("14:30")) => ({ ...haircut(start, "Maya"), mandate }) as unknown as BookInput;

  it.each<[string, Mandate, Record<string, unknown>]>([
    ["price_cap", { priceCapCents: 3499 }, { priceCents: 3500, priceCapCents: 3499 }],
    ["deposit_cap", { depositCapCents: 999 }, { depositCents: 1000, depositCapCents: 999 }],
    [
      "window",
      { window: { from: at("14:00"), to: at("14:45") } },
      { window: { from: at("14:00"), to: at("14:45") }, start: "2026-11-14T19:30:00.000Z", end: "2026-11-14T20:00:00.000Z" },
    ],
  ])("refuses a booking outside the %s with outside_mandate, and books nothing", async (field, mandate, details) => {
    const deps = memoryDeps();
    const err = await rejection(book(deps, "harts", withMandate(mandate), "agent"));
    expect(err.code).toBe("outside_mandate");
    expect(err.nextAction).toBe(MANDATE_NEXT);
    expect(err.details).toEqual({ field, ...details });
    expect(err.message).not.toBe("");
    expect(await saturdayStarts(deps)).toContain(at("14:30"));
    expect(await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toEqual([]);
  });

  it("refuses a start before the window too", async () => {
    const err = await rejection(book(memoryDeps(), "harts", withMandate({ window: { from: at("14:45"), to: at("17:00") } }), "agent"));
    expect(err.details).toMatchObject({ field: "window" });
  });

  it("checks the price first, then the deposit, then the window", async () => {
    const all = { priceCapCents: 1, depositCapCents: 1, window: { from: at("09:00"), to: at("09:30") } };
    expect((await rejection(book(memoryDeps(), "harts", withMandate(all), "agent"))).details).toMatchObject({ field: "price_cap" });
    const noPrice = { depositCapCents: 1, window: all.window };
    expect((await rejection(book(memoryDeps(), "harts", withMandate(noPrice), "agent"))).details).toMatchObject({ field: "deposit_cap" });
  });

  it("books within the limits (each bound inclusive), and stores the mandate on the booking and in its booked event", async () => {
    const deps = memoryDeps();
    const mandate: Mandate = {
      priceCapCents: 3500,
      depositCapCents: 1000,
      window: { from: at("14:30"), to: at("15:00") },
    };
    const { booking } = await book(deps, "harts", withMandate(mandate), "agent");
    expect(booking.status).toBe("awaiting_approval");
    const rows = (deps.store as MemoryStore).consentRows();
    expect(rows.bookings.find((b) => b.id === booking.id)?.mandate).toEqual(mandate);
    expect((await deps.store.listEvents(booking.id))[0].data).toEqual({ status: "awaiting_approval", agentName: "agent", mandate });
  });

  it("accepts a window written in another offset, and caps of 0 for a service without a deposit", async () => {
    const deps = memoryDeps();
    const utc = { window: { from: "2026-11-14T19:00:00Z", to: "2026-11-14T20:00:00Z" }, depositCapCents: 0 };
    const { booking } = await book(deps, "harts", { ...withMandate(utc), service_id: "beard-trim" } as BookInput, "agent");
    expect(booking.serviceId).toBe("beard-trim");
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an empty object", {}],
    ["only null fields", { priceCapCents: null, depositCapCents: null, window: null }],
  ])("treats a mandate of %s as none", async (_label, mandate) => {
    const deps = memoryDeps();
    const { booking } = await book(deps, "harts", withMandate(mandate), "agent");
    expect((deps.store as MemoryStore).consentRows().bookings.find((b) => b.id === booking.id)?.mandate).toBeNull();
    expect((await deps.store.listEvents(booking.id))[0].data).toEqual({ status: "awaiting_approval", agentName: "agent" });
  });

  it.each<[string, unknown, string]>([
    ["a string", "under $50", "mandate"],
    ["an array", [3000], "mandate"],
    ["an unknown field", { maxPrice: 3000 }, "mandate.maxPrice"],
    ["a negative price cap", { priceCapCents: -1 }, "mandate.priceCapCents"],
    ["a fractional deposit cap", { depositCapCents: 10.5 }, "mandate.depositCapCents"],
    ["a cap given as a string", { priceCapCents: "3000" }, "mandate.priceCapCents"],
    ["a cap over $1,000,000", { priceCapCents: 100_000_001 }, "mandate.priceCapCents"],
    ["a window that isn't an object", { window: "Saturday" }, "mandate.window"],
    ["a window without an offset", { window: { from: "2026-11-14T09:00:00", to: at("17:00") } }, "mandate.window.from"],
    ["a window with a missing end", { window: { from: at("09:00") } }, "mandate.window.to"],
    ["a window that ends before it starts", { window: { from: at("17:00"), to: at("09:00") } }, "mandate.window.to"],
    ["an empty window", { window: { from: at("09:00"), to: at("09:00") } }, "mandate.window.to"],
    ["a window with an unknown field", { window: { from: at("09:00"), to: at("17:00"), tz: "EST" } }, "mandate.window.tz"],
  ])("refuses %s with invalid_request naming the field", async (_label, mandate, field) => {
    const deps = memoryDeps();
    const err = await rejection(book(deps, "harts", withMandate(mandate), "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field });
    expect(err.nextAction).toMatch(/priceCapCents/);
    expect(await deps.store.listBookings("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toEqual([]);
  });
});

// ---- On Postgres ----
// The same fixes against a real database, when DATABASE_URL_TEST points at one with every migration and
// the seed applied (see docs/database.md): a lost race books the other staff member, and extreme dates
// and NUL characters never reach a query (Postgres would refuse them, a 500). Like flow-pg.test.ts it never touches Hart's: it makes a throwaway shop (two
// staff members working Tue–Sat 09:00–17:00, a 30-minute service, the default policies), books only
// in 2099, and deletes everything it made in afterAll.
const pgUrl = process.env.DATABASE_URL_TEST?.trim();

if (!pgUrl) {
  describe("book on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run book against a real database", () => {});
  });
} else {
  describe("book on Postgres (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(pgUrl);
    const sql = getPostgresClient(pgUrl);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-book-${run}`;
    const ann = `${shop}-ann`;
    const bob = `${shop}-bob`;
    const zone = "America/New_York";

    // "Now" is 08:00 on a random Tuesday in 2099; with the default 2-hour lead time, starts from 10:00.
    const tuesday = DateTime.fromObject({ year: 2099, month: 1, day: 6 }, { zone })
      .plus({ weeks: Math.floor(Math.random() * 30) })
      .set({ weekday: 2 })
      .startOf("day");
    const time = (hh: number, mm = 0) => tuesday.set({ hour: hh, minute: mm }).toISO({ suppressMilliseconds: true })!;
    const deps: FrontDeskDeps = withBaseUrl({
      catalog: store,
      store,
      clock: fixedClock(new Date(time(8))),
      notifier: recordingNotifier(),
    });

    const trim = (start: string, customer_name = "E2E Book"): BookInput => ({ service_id: "trim", start, customer_name });

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Book Shop', ${zone})`;
      await sql`insert into staff (id, shop_slug, name) values (${ann}, ${shop}, 'Ann'), (${bob}, ${shop}, 'Bob')`;
      await sql`
        insert into weekly_hours (staff_id, weekday, opens, closes)
        select s.id, day, time '09:00', time '17:00'
        from unnest(${[ann, bob]}::text[]) as s(id), generate_series(2, 6) as day
      `;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 0, 1)
      `;
    });

    afterAll(async () => {
      await sql`delete from bookings where shop_slug = ${shop}`; // events cascade
      await sql`delete from shops where slug = ${shop}`; // staff, hours and services cascade
      await closePostgresClients();
    });

    it("books the other staff member when the race for the first is lost", async () => {
      const winner = await book(deps, shop, trim(time(10)), "vitest A");
      expect(winner.booking.staffId).toBe(ann);

      const loser = await book(staleOnce(deps), shop, trim(time(10), "E2E Loser"), "vitest B");
      expect(loser.booking).toMatchObject({ staffId: bob, start: time(10), status: "awaiting_approval" });
      expect(loser.staffName).toBe("Bob");
      expect(loser.booking.approval?.url).not.toBe(winner.booking.approval?.url);
      expect(await deps.store.listEvents(loser.booking.id)).toHaveLength(1);
      // Both staff members are now held at 10:00: a third call is slot_taken.
      expect((await rejection(book(deps, shop, trim(time(10), "E2E Third"), "vitest C"))).code).toBe("slot_taken");
    });

    it("is too_far for year 9999 and too_soon for year 1, and get_availability offers nothing there", async () => {
      expect((await rejection(book(deps, shop, trim("9999-12-31T15:00:00Z"), "vitest"))).code).toBe("too_far");
      expect((await rejection(book(deps, shop, trim("0001-01-01T15:00:00Z"), "vitest"))).code).toBe("too_soon");
      for (const window of [
        { from: "9999-12-30T00:00:00Z", to: "9999-12-31T00:00:00Z" },
        { from: "0001-01-01T00:00:00Z", to: "0001-01-02T00:00:00Z" },
      ]) {
        expect(await getAvailability(deps, shop, { service_id: "trim", ...window })).toEqual({ slots: [], truncated: false });
      }
    });

    it("refuses NUL in customer_name, strips it from the agent name, and treats a slug with it as not_found", async () => {
      const err = await rejection(book(deps, shop, trim(time(11), "E2E\u0000Nul"), "vitest"));
      expect(err.code).toBe("invalid_request");
      expect(err.details).toMatchObject({ field: "customer_name" });

      const { booking } = await book(deps, shop, trim(time(11)), "vitest\u0000agent");
      expect(booking.agent.name).toBe("vitestagent");

      expect((await rejection(listServices(deps, `${shop}\u0000`))).code).toBe("not_found");
    });
  });
}
