import { describe, expect, it } from "vitest";
import type { BusyInterval, StaffHours } from "../frontdesk/catalog";
import { FrontDeskError } from "../frontdesk/errors";
import {
  bookingBounds,
  ceilToGrid,
  checkStart,
  computeAvailability,
  MAX_LIMIT,
  nearbySlots,
  resolveLocalTime,
  type AvailabilityInput,
  type BookingRules,
  type StartCheckInput,
} from "./availability";

// All cases use America/New_York and a fixed `now`. 2026-11-10 is a Tuesday (EST, UTC-5).
const ZONE = "America/New_York";
const d = (iso: string) => new Date(iso);

const TUE_9_TO_5: StaffHours[] = [
  { staffId: "dana", weekly: [{ weekday: 2, open: "09:00", close: "17:00" }] },
];

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timezone: ZONE,
    durationMin: 30,
    staffHours: TUE_9_TO_5,
    busy: [],
    from: d("2026-11-10T00:00:00-05:00"),
    to: d("2026-11-11T00:00:00-05:00"),
    now: d("2026-11-09T08:00:00-05:00"),
    limit: 50,
    ...overrides,
  };
}

/** "09:00", "09:15", … in local time, from RFC 3339 starts like 2026-11-10T09:00:00-05:00. */
const localTimes = (starts: string[]) => starts.map((s) => s.slice(11, 16));

function expectApiError(fn: () => unknown, code: string): FrontDeskError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FrontDeskError);
    expect((err as FrontDeskError).code).toBe(code);
    expect((err as FrontDeskError).nextAction).not.toBe("");
    return err as FrontDeskError;
  }
  throw new Error("expected a FrontDeskError");
}

describe("computeAvailability", () => {
  it("A-1: hours 9–17, 30 min service, nothing busy → starts 9:00 to 16:30 every 15 minutes", () => {
    const { slots, truncated } = computeAvailability(input());

    const expected: string[] = [];
    for (let m = 9 * 60; m <= 16 * 60 + 30; m += 15) {
      expected.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
    expect(expected).toHaveLength(31);
    expect(localTimes(slots.map((s) => s.start))).toEqual(expected);
    expect(truncated).toBe(false);

    expect(slots[0]).toEqual({
      start: "2026-11-10T09:00:00-05:00",
      end: "2026-11-10T09:30:00-05:00",
      staffId: "dana",
      display: "Tue 10 Nov, 9:00 am EST",
    });
    expect(slots.at(-1)).toMatchObject({
      start: "2026-11-10T16:30:00-05:00",
      end: "2026-11-10T17:00:00-05:00",
      display: "Tue 10 Nov, 4:30 pm EST",
    });
  });

  it("A-3: busy 10:00–10:30 → 9:45 and 10:15 excluded, 10:30 included (half-open)", () => {
    const busy: BusyInterval[] = [
      { staffId: "dana", start: d("2026-11-10T10:00:00-05:00"), end: d("2026-11-10T10:30:00-05:00") },
    ];
    const times = localTimes(computeAvailability(input({ busy })).slots.map((s) => s.start));

    expect(times).not.toContain("09:45");
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("10:15");
    expect(times).toContain("09:30"); // ends exactly when the busy interval starts
    expect(times).toContain("10:30"); // starts exactly when the busy interval ends
    expect(times).toHaveLength(31 - 3);
  });

  it("A-7: identical inputs twice → identical outputs", () => {
    const busy: BusyInterval[] = [
      { staffId: "dana", start: d("2026-11-10T12:00:00-05:00"), end: d("2026-11-10T12:30:00-05:00") },
    ];
    const first = computeAvailability(input({ busy, limit: 10 }));
    const second = computeAvailability(input({ busy, limit: 10 }));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("rejects a 15-day window with invalid_request", () => {
    const err = expectApiError(
      () =>
        computeAvailability(
          input({ from: d("2026-11-10T00:00:00-05:00"), to: d("2026-11-25T00:00:00-05:00") }),
        ),
      "invalid_request",
    );
    expect(err.details).toMatchObject({ maxWindowDays: 14 });
  });

  it("accepts a window of exactly 14 days", () => {
    const { slots } = computeAvailability(
      input({ from: d("2026-11-10T00:00:00-05:00"), to: d("2026-11-24T00:00:00-05:00") }),
    );
    expect(slots.length).toBeGreaterThan(0);
  });

  it("rejects from >= to with invalid_request", () => {
    expectApiError(
      () => computeAvailability(input({ from: d("2026-11-11T00:00:00-05:00"), to: d("2026-11-10T00:00:00-05:00") })),
      "invalid_request",
    );
    expectApiError(
      () => computeAvailability(input({ from: d("2026-11-10T00:00:00-05:00"), to: d("2026-11-10T00:00:00-05:00") })),
      "invalid_request",
    );
  });

  it("limit caps the result and sets truncated", () => {
    const five = computeAvailability(input({ limit: 5 }));
    expect(five.slots).toHaveLength(5);
    expect(five.truncated).toBe(true);
    expect(localTimes(five.slots.map((s) => s.start))).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);

    const exact = computeAvailability(input({ limit: 31 }));
    expect(exact.slots).toHaveLength(31);
    expect(exact.truncated).toBe(false);
  });

  it("defaults limit to 20 and rejects limits outside 1–50", () => {
    const byDefault = computeAvailability(input({ limit: undefined }));
    expect(byDefault.slots).toHaveLength(20);
    expect(byDefault.truncated).toBe(true);

    for (const limit of [0, 51, 2.5]) {
      expectApiError(() => computeAvailability(input({ limit })), "invalid_request");
    }
  });

  it("drops starts before now", () => {
    const { slots } = computeAvailability(input({ now: d("2026-11-10T10:07:00-05:00") }));
    expect(slots[0].start).toBe("2026-11-10T10:15:00-05:00");
  });

  it("keeps a start exactly at now", () => {
    const { slots } = computeAvailability(input({ now: d("2026-11-10T10:00:00-05:00") }));
    expect(slots[0].start).toBe("2026-11-10T10:00:00-05:00");
  });

  it("only offers starts inside [from, to)", () => {
    const { slots } = computeAvailability(
      input({ from: d("2026-11-10T11:00:00-05:00"), to: d("2026-11-10T12:00:00-05:00") }),
    );
    expect(localTimes(slots.map((s) => s.start))).toEqual(["11:00", "11:15", "11:30", "11:45"]);
  });

  it("never lets an appointment run past closing", () => {
    const { slots } = computeAvailability(input({ durationMin: 45 }));
    expect(slots.at(-1)?.start).toBe("2026-11-10T16:15:00-05:00");
    expect(slots.at(-1)?.end).toBe("2026-11-10T17:00:00-05:00");
  });

  it("ignores busy time belonging to another staff member", () => {
    const busy: BusyInterval[] = [
      { staffId: "someone-else", start: d("2026-11-10T09:00:00-05:00"), end: d("2026-11-10T17:00:00-05:00") },
    ];
    expect(computeAvailability(input({ busy })).slots).toHaveLength(31);
  });

  it("returns nothing on a closed day", () => {
    const { slots, truncated } = computeAvailability(
      input({ from: d("2026-11-09T00:00:00-05:00"), to: d("2026-11-10T00:00:00-05:00") }), // Monday
    );
    expect(slots).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("expands hours in the shop's zone even when the window is given in UTC", () => {
    const { slots } = computeAvailability(
      input({ from: d("2026-11-10T05:00:00Z"), to: d("2026-11-11T05:00:00Z") }),
    );
    expect(slots[0].start).toBe("2026-11-10T09:00:00-05:00");
    expect(slots).toHaveLength(31);
  });

  it("formats display in the shop's zone, with EDT in summer", () => {
    const summer: StaffHours[] = [
      { staffId: "dana", weekly: [{ weekday: 6, open: "14:30", close: "15:00" }] },
    ];
    const { slots } = computeAvailability(
      input({
        staffHours: summer,
        from: d("2026-07-11T00:00:00-04:00"),
        to: d("2026-07-12T00:00:00-04:00"),
        now: d("2026-07-01T00:00:00-04:00"),
      }),
    );
    expect(slots).toEqual([
      {
        start: "2026-07-11T14:30:00-04:00",
        end: "2026-07-11T15:00:00-04:00",
        staffId: "dana",
        display: "Sat 11 Jul, 2:30 pm EDT",
      },
    ]);
  });

  it("sorts across staff by start, then staffId", () => {
    const twoStaff: StaffHours[] = [
      { staffId: "zoe", weekly: [{ weekday: 2, open: "09:00", close: "10:00" }] },
      { staffId: "dana", weekly: [{ weekday: 2, open: "09:15", close: "10:00" }] },
    ];
    const { slots } = computeAvailability(input({ staffHours: twoStaff }));
    expect(slots.map((s) => `${s.start.slice(11, 16)} ${s.staffId}`)).toEqual([
      "09:00 zoe",
      "09:15 dana",
      "09:15 zoe",
      "09:30 dana",
      "09:30 zoe",
    ]);
  });
});

// ---- Ring 1a: booking rules, daylight saving, checkStart and nearbySlots ----

/** DEFAULT_POLICIES: a 2-hour lead time, a 30-day horizon, 6 days for a service with a deposit. */
const RULES: BookingRules = { leadTimeMin: 120, horizonDays: 30, depositHorizonDays: 6, paused: false };

const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;
const EVERY_DAY_9_TO_5: StaffHours[] = [
  { staffId: "dana", weekly: ALL_WEEK.map((weekday) => ({ weekday, open: "09:00", close: "17:00" })) },
];
/** One 30-minute slot a day, at 09:00. */
const EVERY_DAY_9_TO_930: StaffHours[] = [
  { staffId: "dana", weekly: ALL_WEEK.map((weekday) => ({ weekday, open: "09:00", close: "09:30" })) },
];
const SUNDAY = (open: string, close: string): StaffHours[] => [
  { staffId: "dana", weekly: [{ weekday: 7, open, close }] },
];

const startsOf = (slots: { start: string }[]) => slots.map((s) => s.start);
const ymd = (year: number, month: number, day: number) => ({ year, month, day });

describe("computeAvailability with booking rules", () => {
  it("A-2: same day, 2-hour lead time → nothing before now + 2 h, rounded up to the grid", () => {
    const now = d("2026-11-10T10:07:00-05:00");
    const { slots } = computeAvailability(input({ now, rules: RULES }));

    expect(slots[0].start).toBe("2026-11-10T12:15:00-05:00"); // 12:07 rounded up
    for (const s of slots) {
      expect(new Date(s.start).getTime()).toBeGreaterThanOrEqual(now.getTime() + 120 * 60_000);
    }
    expect(slots).toHaveLength(18); // 12:15 … 16:30
  });

  it("A-2: a lead time that ends on the grid keeps that start", () => {
    const { slots } = computeAvailability(input({ now: d("2026-11-10T10:00:00-05:00"), rules: RULES }));
    expect(slots[0].start).toBe("2026-11-10T12:00:00-05:00");
  });

  it("starts at from when from is later than now + lead time", () => {
    const { slots } = computeAvailability(
      input({ now: d("2026-11-10T08:00:00-05:00"), from: d("2026-11-10T13:00:00-05:00"), rules: RULES }),
    );
    expect(slots[0].start).toBe("2026-11-10T13:00:00-05:00");
  });

  it("A-4: a block covering the afternoon → no afternoon starts", () => {
    const busy: BusyInterval[] = [
      {
        staffId: "dana",
        kind: "block",
        start: d("2026-11-10T12:00:00-05:00"),
        end: d("2026-11-10T17:00:00-05:00"),
        reason: "Time off",
      },
    ];
    const { slots } = computeAvailability(input({ busy, rules: RULES }));
    expect(localTimes(startsOf(slots))).toEqual([
      "09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45", "11:00", "11:15", "11:30",
    ]);
  });

  it("A-5: a deposit service over a 10-day window → nothing at or beyond now + 6 days; no deposit → all 10 days", () => {
    const now = d("2026-11-08T20:00:00-05:00");
    const base = input({
      staffHours: EVERY_DAY_9_TO_930,
      from: d("2026-11-09T00:00:00-05:00"),
      to: d("2026-11-19T00:00:00-05:00"),
      now,
      rules: RULES,
    });
    const nineAm = (day: number) => `2026-11-${String(day).padStart(2, "0")}T09:00:00-05:00`;

    const withDeposit = computeAvailability({ ...base, depositCents: 1000 });
    expect(startsOf(withDeposit.slots)).toEqual([9, 10, 11, 12, 13, 14].map(nineAm));
    const sixDaysOut = d("2026-11-14T20:00:00-05:00").getTime();
    for (const s of withDeposit.slots) expect(new Date(s.start).getTime()).toBeLessThan(sixDaysOut);

    const noDeposit = computeAvailability({ ...base, depositCents: 0 });
    expect(startsOf(noDeposit.slots)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(nineAm));
  });

  it("A-5: a start exactly at now + horizon is not offered (the bound is exclusive)", () => {
    const { slots } = computeAvailability(
      input({
        staffHours: EVERY_DAY_9_TO_930,
        from: d("2026-11-13T00:00:00-05:00"),
        to: d("2026-11-16T00:00:00-05:00"),
        now: d("2026-11-08T09:00:00-05:00"),
        depositCents: 500,
        rules: RULES,
      }),
    );
    expect(startsOf(slots)).toEqual(["2026-11-13T09:00:00-05:00"]); // 14 Nov 09:00 is exactly 6 days out
  });

  it("without rules there is no horizon, even for a deposit service", () => {
    const { slots } = computeAvailability(
      input({ from: d("2026-12-22T00:00:00-05:00"), to: d("2026-12-23T00:00:00-05:00"), depositCents: 1000 }),
    );
    expect(slots).toHaveLength(31);
  });

  it("paused → no slots, after the request is validated", () => {
    const paused = { ...RULES, paused: true };
    expect(computeAvailability(input({ rules: paused }))).toEqual({ slots: [], truncated: false });
    expectApiError(() => computeAvailability(input({ rules: paused, limit: 0 })), "invalid_request");
    expectApiError(
      () => computeAvailability(input({ rules: paused, to: d("2026-11-10T00:00:00-05:00") })),
      "invalid_request",
    );
  });
});

describe("computeAvailability across daylight saving (America/New_York)", () => {
  it("A-6: spring-forward day, hours 01:00–05:00 → no start at the missing 02:00–02:59, all others present", () => {
    const { slots } = computeAvailability(
      input({
        staffHours: SUNDAY("01:00", "05:00"),
        from: d("2026-03-08T00:00:00-05:00"),
        to: d("2026-03-09T00:00:00-04:00"),
        now: d("2026-03-01T12:00:00-05:00"),
        rules: RULES,
      }),
    );
    expect(startsOf(slots)).toEqual([
      "2026-03-08T01:00:00-05:00",
      "2026-03-08T01:15:00-05:00",
      "2026-03-08T01:30:00-05:00",
      "2026-03-08T01:45:00-05:00",
      "2026-03-08T03:00:00-04:00",
      "2026-03-08T03:15:00-04:00",
      "2026-03-08T03:30:00-04:00",
      "2026-03-08T03:45:00-04:00",
      "2026-03-08T04:00:00-04:00",
      "2026-03-08T04:15:00-04:00",
      "2026-03-08T04:30:00-04:00",
    ]);
    // 01:45 EST + 30 minutes of real time ends at 03:15 EDT.
    expect(slots[3]).toEqual({
      start: "2026-03-08T01:45:00-05:00",
      end: "2026-03-08T03:15:00-04:00",
      staffId: "dana",
      display: "Sun 8 Mar, 1:45 am EST",
    });
    expect(slots[4].display).toBe("Sun 8 Mar, 3:00 am EDT");
    expect(slots.at(-1)?.end).toBe("2026-03-08T05:00:00-04:00");
  });

  it("fall-back day, hours 01:00–03:00 → the repeated 01:xx starts appear once in EDT, then once in EST", () => {
    const { slots } = computeAvailability(
      input({
        staffHours: SUNDAY("01:00", "03:00"),
        from: d("2026-11-01T00:00:00-04:00"),
        to: d("2026-11-02T00:00:00-05:00"),
        now: d("2026-10-25T12:00:00-04:00"),
        rules: RULES,
      }),
    );
    expect(startsOf(slots)).toEqual([
      "2026-11-01T01:00:00-04:00",
      "2026-11-01T01:15:00-04:00",
      "2026-11-01T01:30:00-04:00",
      "2026-11-01T01:45:00-04:00",
      "2026-11-01T01:00:00-05:00",
      "2026-11-01T01:15:00-05:00",
      "2026-11-01T01:30:00-05:00",
      "2026-11-01T01:45:00-05:00",
      "2026-11-01T02:00:00-05:00",
      "2026-11-01T02:15:00-05:00",
      "2026-11-01T02:30:00-05:00",
    ]);
    expect(slots[0].display).toBe("Sun 1 Nov, 1:00 am EDT");
    expect(slots[4].display).toBe("Sun 1 Nov, 1:00 am EST");
    expect(slots[3].end).toBe("2026-11-01T01:15:00-05:00"); // 01:45 EDT + 30 minutes
  });

  it("hours that open inside the spring gap (02:30) start at 03:00 EDT; a close inside it means 03:00 EDT too", () => {
    const window = {
      from: d("2026-03-08T00:00:00-05:00"),
      to: d("2026-03-09T00:00:00-04:00"),
      now: d("2026-03-01T12:00:00-05:00"),
      rules: RULES,
    };
    const opensInGap = computeAvailability(input({ ...window, staffHours: SUNDAY("02:30", "04:00") }));
    expect(startsOf(opensInGap.slots)).toEqual([
      "2026-03-08T03:00:00-04:00",
      "2026-03-08T03:15:00-04:00",
      "2026-03-08T03:30:00-04:00",
    ]);

    const closesInGap = computeAvailability(input({ ...window, staffHours: SUNDAY("01:00", "02:30") }));
    expect(startsOf(closesInGap.slots)).toEqual([
      "2026-03-08T01:00:00-05:00",
      "2026-03-08T01:15:00-05:00",
      "2026-03-08T01:30:00-05:00",
    ]);
  });
});

describe("resolveLocalTime", () => {
  it("moves a time in the spring gap forward to the instant the gap ends", () => {
    for (const minute of [0, 30, 59]) {
      expect(resolveLocalTime(ZONE, ymd(2026, 3, 8), 2, minute).toISO()).toBe("2026-03-08T03:00:00.000-04:00");
    }
    expect(resolveLocalTime("Europe/London", ymd(2026, 3, 29), 1, 30).toISO()).toBe(
      "2026-03-29T02:00:00.000+01:00",
    );
    expect(resolveLocalTime("Australia/Sydney", ymd(2026, 10, 4), 2, 30).toISO()).toBe(
      "2026-10-04T03:00:00.000+11:00",
    );
  });

  it("uses the first occurrence of a time repeated in the autumn overlap", () => {
    const dt = resolveLocalTime(ZONE, ymd(2026, 11, 1), 1, 30);
    expect(dt.toISO()).toBe("2026-11-01T01:30:00.000-04:00");
    expect(dt.toMillis()).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(resolveLocalTime(ZONE, ymd(2026, 11, 1), 1, 0).toISO()).toBe("2026-11-01T01:00:00.000-04:00");
    expect(resolveLocalTime("Australia/Sydney", ymd(2026, 4, 5), 2, 30).toISO()).toBe(
      "2026-04-05T02:30:00.000+11:00",
    );
  });

  it("resolves ordinary times, including those right next to a transition", () => {
    expect(resolveLocalTime(ZONE, ymd(2026, 11, 10), 9, 0).toISO()).toBe("2026-11-10T09:00:00.000-05:00");
    expect(resolveLocalTime(ZONE, ymd(2026, 7, 11), 14, 30).toISO()).toBe("2026-07-11T14:30:00.000-04:00");
    expect(resolveLocalTime(ZONE, ymd(2026, 3, 8), 1, 59).toISO()).toBe("2026-03-08T01:59:00.000-05:00");
    expect(resolveLocalTime(ZONE, ymd(2026, 3, 8), 3, 0).toISO()).toBe("2026-03-08T03:00:00.000-04:00");
    expect(resolveLocalTime(ZONE, ymd(2026, 11, 1), 0, 59).toISO()).toBe("2026-11-01T00:59:00.000-04:00");
    expect(resolveLocalTime(ZONE, ymd(2026, 11, 1), 2, 0).toISO()).toBe("2026-11-01T02:00:00.000-05:00");
  });

  it("works in zones without daylight saving", () => {
    expect(resolveLocalTime("Asia/Kolkata", ymd(2026, 3, 8), 2, 30).toISO()).toBe("2026-03-08T02:30:00.000+05:30");
    expect(resolveLocalTime("America/Phoenix", ymd(2026, 3, 8), 2, 30).toISO()).toBe(
      "2026-03-08T02:30:00.000-07:00",
    );
  });

  it("returns a DateTime in the given zone and throws for an unknown zone", () => {
    expect(resolveLocalTime(ZONE, ymd(2026, 11, 10), 9, 0).zoneName).toBe(ZONE);
    expect(() => resolveLocalTime("Mars/Olympus_Mons", ymd(2026, 11, 10), 9, 0)).toThrow();
  });
});

describe("ceilToGrid", () => {
  const same = (iso: string) => expect(ceilToGrid(d(iso), ZONE).getTime()).toBe(d(iso).getTime());
  const rounds = (iso: string, expected: string) =>
    expect(ceilToGrid(d(iso), ZONE).getTime()).toBe(d(expected).getTime());

  it("leaves an instant on the grid unchanged", () => {
    same("2026-11-10T10:00:00-05:00");
    same("2026-11-10T10:45:00-05:00");
    same("2026-11-10T00:00:00-05:00");
  });

  it("rounds anything else up to the next local quarter hour", () => {
    rounds("2026-11-10T10:07:00-05:00", "2026-11-10T10:15:00-05:00");
    rounds("2026-11-10T10:00:01-05:00", "2026-11-10T10:15:00-05:00");
    rounds("2026-11-10T10:00:00.001-05:00", "2026-11-10T10:15:00-05:00");
    rounds("2026-11-10T10:44:59-05:00", "2026-11-10T10:45:00-05:00");
    rounds("2026-11-10T23:53:00-05:00", "2026-11-11T00:00:00-05:00");
  });

  it("uses the shop's local grid and adds elapsed time", () => {
    // India is UTC+05:30: an hour grid lands on the local hour, not the UTC one.
    expect(ceilToGrid(d("2026-11-10T10:07:00+05:30"), "Asia/Kolkata", 60).getTime()).toBe(
      d("2026-11-10T11:00:00+05:30").getTime(),
    );
    // Spring forward: 01:50 EST + 10 minutes is 03:00 EDT.
    rounds("2026-03-08T01:50:00-05:00", "2026-03-08T03:00:00-04:00");
  });
});

describe("bookingBounds", () => {
  const now = d("2026-11-10T10:07:00-05:00");

  it("without rules: from now, with no horizon", () => {
    expect(bookingBounds({ now, timezone: ZONE })).toEqual({ earliest: now, latest: null });
    expect(bookingBounds({ now, timezone: ZONE, depositCents: 1000 })).toEqual({ earliest: now, latest: null });
  });

  it("with rules: now + lead time rounded up to the grid, until now + horizonDays", () => {
    const expected = { earliest: d("2026-11-10T12:15:00-05:00"), latest: d("2026-12-10T10:07:00-05:00") };
    expect(bookingBounds({ now, timezone: ZONE, rules: RULES })).toEqual(expected);
    expect(bookingBounds({ now, timezone: ZONE, depositCents: 0, rules: RULES })).toEqual(expected);
  });

  it("with a deposit: until now + depositHorizonDays", () => {
    expect(bookingBounds({ now, timezone: ZONE, depositCents: 1000, rules: RULES })).toEqual({
      earliest: d("2026-11-10T12:15:00-05:00"),
      latest: d("2026-11-16T10:07:00-05:00"),
    });
  });

  it("adds calendar days in the shop's zone: the same local time across a DST change", () => {
    const deposit = { timezone: ZONE, depositCents: 1000, rules: RULES };
    expect(bookingBounds({ ...deposit, now: d("2026-03-05T10:00:00-05:00") }).latest).toEqual(
      d("2026-03-11T10:00:00-04:00"),
    );
    expect(bookingBounds({ ...deposit, now: d("2026-10-29T10:00:00-04:00") }).latest).toEqual(
      d("2026-11-04T10:00:00-05:00"),
    );
  });
});

/** A Tuesday 9–17 shop with Hart's rules, seen from Monday 9 Nov 08:00. */
function startInput(overrides: Partial<StartCheckInput> = {}): StartCheckInput {
  return {
    timezone: ZONE,
    durationMin: 30,
    staffHours: TUE_9_TO_5,
    busy: [],
    now: d("2026-11-09T08:00:00-05:00"),
    rules: RULES,
    ...overrides,
  };
}

const TWO_STAFF: StaffHours[] = [
  { staffId: "zoe", weekly: [{ weekday: 2, open: "09:00", close: "17:00" }] },
  { staffId: "dana", weekly: [{ weekday: 2, open: "09:00", close: "17:00" }] },
];
const booking = (start: string, end: string, staffId = "dana"): BusyInterval => ({
  staffId,
  kind: "booking",
  start: d(start),
  end: d(end),
});
const block = (start: string, end: string, staffId = "dana"): BusyInterval => ({
  staffId,
  kind: "block",
  start: d(start),
  end: d(end),
});

describe("checkStart", () => {
  const at = (iso: string, overrides: Partial<StartCheckInput> = {}) => checkStart(startInput(overrides), d(iso));
  const reason = (iso: string, overrides: Partial<StartCheckInput> = {}) => {
    const result = at(iso, overrides);
    return result.ok ? "ok" : result.reason;
  };

  it("ok: returns the slot for a free start", () => {
    expect(at("2026-11-10T10:00:00-05:00")).toEqual({
      ok: true,
      slot: {
        start: "2026-11-10T10:00:00-05:00",
        end: "2026-11-10T10:30:00-05:00",
        staffId: "dana",
        display: "Tue 10 Nov, 10:00 am EST",
      },
    });
  });

  it("ok: picks the first free staff member by staffId", () => {
    const start = "2026-11-10T10:00:00-05:00";
    const first = at(start, { staffHours: TWO_STAFF });
    expect(first.ok && first.slot.staffId).toBe("dana");

    const busy = [booking("2026-11-10T10:00:00-05:00", "2026-11-10T10:30:00-05:00", "dana")];
    const other = at(start, { staffHours: TWO_STAFF, busy });
    expect(other.ok && other.slot.staffId).toBe("zoe");
  });

  it("paused comes first, even for a start in the past", () => {
    expect(at("2026-11-01T10:00:00-05:00", { rules: { ...RULES, paused: true } })).toEqual({
      ok: false,
      reason: "paused",
    });
  });

  it("too_soon: before now + lead time, with the earliest allowed start", () => {
    const now = d("2026-11-10T10:07:00-05:00");
    expect(at("2026-11-10T12:00:00-05:00", { now })).toEqual({
      ok: false,
      reason: "too_soon",
      earliest: d("2026-11-10T12:15:00-05:00"),
    });
    expect(reason("2026-11-10T12:07:00-05:00", { now })).toBe("too_soon"); // off the grid, but too soon first
    expect(reason("2026-11-10T12:15:00-05:00", { now })).toBe("ok");
    // Without rules only the past is too soon.
    expect(at("2026-11-10T10:00:00-05:00", { now, rules: undefined })).toEqual({
      ok: false,
      reason: "too_soon",
      earliest: now,
    });
    expect(reason("2026-11-10T10:15:00-05:00", { now, rules: undefined })).toBe("ok");
  });

  it("too_far: at or after now + horizon, with the bound", () => {
    expect(at("2026-12-09T08:00:00-05:00")).toEqual({
      ok: false,
      reason: "too_far",
      latest: d("2026-12-09T08:00:00-05:00"),
    });
    // A deposit service has the shorter horizon.
    expect(at("2026-11-17T10:00:00-05:00", { depositCents: 1000 })).toEqual({
      ok: false,
      reason: "too_far",
      latest: d("2026-11-15T08:00:00-05:00"),
    });
    expect(reason("2026-11-17T10:00:00-05:00", { depositCents: 0 })).toBe("ok");
  });

  it("taken: a booking is in the way (kind booking, or no kind)", () => {
    const busy = [booking("2026-11-10T10:00:00-05:00", "2026-11-10T10:30:00-05:00")];
    expect(at("2026-11-10T10:00:00-05:00", { busy })).toEqual({ ok: false, reason: "taken" });
    expect(reason("2026-11-10T09:45:00-05:00", { busy })).toBe("taken"); // would run into it
    expect(reason("2026-11-10T10:30:00-05:00", { busy })).toBe("ok"); // back-to-back

    const noKind: BusyInterval = {
      staffId: "dana",
      start: d("2026-11-10T10:00:00-05:00"),
      end: d("2026-11-10T10:30:00-05:00"),
    };
    expect(reason("2026-11-10T10:00:00-05:00", { busy: [noKind] })).toBe("taken");
  });

  it("outside_hours: blocked time is not 'taken'", () => {
    const busy = [block("2026-11-10T10:00:00-05:00", "2026-11-10T10:30:00-05:00")];
    expect(at("2026-11-10T10:00:00-05:00", { busy })).toEqual({ ok: false, reason: "outside_hours" });
    // Both a booking and a block in the way: still outside_hours.
    const both = [...busy, booking("2026-11-10T10:00:00-05:00", "2026-11-10T10:30:00-05:00")];
    expect(reason("2026-11-10T10:00:00-05:00", { busy: both })).toBe("outside_hours");
  });

  it("outside_hours: off the grid, closed, a break, or running past closing", () => {
    expect(reason("2026-11-10T10:07:00-05:00")).toBe("outside_hours");
    expect(reason("2026-11-16T10:00:00-05:00")).toBe("outside_hours"); // Monday
    expect(reason("2026-11-10T16:45:00-05:00")).toBe("outside_hours"); // ends 17:15
    expect(reason("2026-11-10T17:00:00-05:00")).toBe("outside_hours");
    expect(reason("2026-11-10T08:45:00-05:00")).toBe("outside_hours");

    const withLunch: StaffHours[] = [
      {
        staffId: "dana",
        weekly: [
          { weekday: 2, open: "09:00", close: "12:00" },
          { weekday: 2, open: "13:00", close: "17:00" },
        ],
      },
    ];
    expect(reason("2026-11-10T11:45:00-05:00", { staffHours: withLunch })).toBe("outside_hours");
    expect(reason("2026-11-10T12:15:00-05:00", { staffHours: withLunch })).toBe("outside_hours");
    expect(reason("2026-11-10T13:00:00-05:00", { staffHours: withLunch })).toBe("ok");
  });

  it("agrees with computeAvailability at every quarter hour (normal, spring and autumn days)", () => {
    const cases: { overrides: Partial<StartCheckInput>; from: string; to: string }[] = [
      {
        overrides: {
          now: d("2026-11-10T10:07:00-05:00"),
          staffHours: TWO_STAFF,
          busy: [
            booking("2026-11-10T13:00:00-05:00", "2026-11-10T14:00:00-05:00", "dana"),
            block("2026-11-10T15:00:00-05:00", "2026-11-10T17:00:00-05:00", "zoe"),
          ],
        },
        from: "2026-11-10T00:00:00-05:00",
        to: "2026-11-11T00:00:00-05:00",
      },
      {
        overrides: { now: d("2026-03-01T12:00:00-05:00"), staffHours: SUNDAY("01:00", "05:00") },
        from: "2026-03-08T00:00:00-05:00",
        to: "2026-03-09T00:00:00-04:00",
      },
      {
        overrides: { now: d("2026-10-25T12:00:00-04:00"), staffHours: SUNDAY("00:30", "03:00") },
        from: "2026-11-01T00:00:00-04:00",
        to: "2026-11-02T00:00:00-05:00",
      },
    ];
    for (const { overrides, from, to } of cases) {
      const shop = startInput(overrides);
      const { slots } = computeAvailability({ ...shop, from: d(from), to: d(to), limit: 50 });
      const offered = new Set(slots.map((s) => new Date(s.start).getTime()));
      expect(offered.size).toBeGreaterThan(0);
      for (let t = d(from).getTime(); t < d(to).getTime(); t += 15 * 60_000) {
        expect(checkStart(shop, new Date(t)).ok).toBe(offered.has(t));
      }
    }
  });
});

describe("nearbySlots", () => {
  const busy = [booking("2026-11-10T10:00:00-05:00", "2026-11-10T10:30:00-05:00")];

  it("returns the 3 free slots nearest the start, earliest first", () => {
    const slots = nearbySlots(startInput({ busy }), d("2026-11-10T10:00:00-05:00"));
    // 09:30 and 10:30 are 30 minutes away; 09:15 and 10:45 are 45 minutes away.
    expect(localTimes(startsOf(slots))).toEqual(["09:15", "09:30", "10:30"]);
    expect(slots[0]).toEqual({
      start: "2026-11-10T09:15:00-05:00",
      end: "2026-11-10T09:45:00-05:00",
      staffId: "dana",
      display: "Tue 10 Nov, 9:15 am EST",
    });
  });

  it("breaks a tie in distance by taking the earlier slot", () => {
    const start = d("2026-11-10T10:00:00-05:00");
    expect(localTimes(startsOf(nearbySlots(startInput({ busy }), start, 1)))).toEqual(["09:30"]);
    expect(localTimes(startsOf(nearbySlots(startInput({ busy }), start, 2)))).toEqual(["09:30", "10:30"]);
    expect(nearbySlots(startInput({ busy }), start, 0)).toEqual([]);
  });

  it("respects the lead time", () => {
    const slots = nearbySlots(startInput({ now: d("2026-11-10T10:07:00-05:00") }), d("2026-11-10T12:00:00-05:00"));
    expect(localTimes(startsOf(slots))).toEqual(["12:15", "12:30", "12:45"]);
  });

  it("respects the horizon", () => {
    const slots = nearbySlots(
      startInput({ staffHours: EVERY_DAY_9_TO_5, now: d("2026-11-08T09:00:00-05:00"), depositCents: 1000 }),
      d("2026-11-14T09:00:00-05:00"), // exactly 6 days out: nothing from here on
    );
    expect(startsOf(slots)).toEqual([
      "2026-11-13T16:00:00-05:00",
      "2026-11-13T16:15:00-05:00",
      "2026-11-13T16:30:00-05:00",
    ]);
  });

  it("only looks 24 hours either side of the start (inclusive)", () => {
    expect(startsOf(nearbySlots(startInput(), d("2026-11-11T16:30:00-05:00")))).toEqual([
      "2026-11-10T16:30:00-05:00",
    ]);
    expect(nearbySlots(startInput(), d("2026-11-11T16:45:00-05:00"))).toEqual([]);
    expect(startsOf(nearbySlots(startInput(), d("2026-11-09T09:00:00-05:00")))).toEqual([
      "2026-11-10T09:00:00-05:00",
    ]);
    expect(nearbySlots(startInput(), d("2026-11-09T08:45:00-05:00"))).toEqual([]);
  });

  it("returns nothing when paused", () => {
    expect(nearbySlots(startInput({ rules: { ...RULES, paused: true } }), d("2026-11-10T10:00:00-05:00"))).toEqual(
      [],
    );
  });

  it("is not capped by MAX_LIMIT", () => {
    const slots = nearbySlots(
      startInput({ staffHours: EVERY_DAY_9_TO_5 }),
      d("2026-11-11T12:00:00-05:00"),
      100,
    );
    // Tue 12:00–16:30 (19), all of Wed (31), Thu 09:00–12:00 (13).
    expect(slots).toHaveLength(63);
    expect(slots.length).toBeGreaterThan(MAX_LIMIT);
    expect(slots[0].start).toBe("2026-11-10T12:00:00-05:00");
    expect(slots.at(-1)?.start).toBe("2026-11-12T12:00:00-05:00");
    const times = slots.map((s) => new Date(s.start).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
