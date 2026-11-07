import { describe, expect, it } from "vitest";
import type { BusyInterval, StaffHours } from "../frontdesk/catalog";
import { FrontDeskError } from "../frontdesk/errors";
import { computeAvailability, type AvailabilityInput } from "./availability";

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
