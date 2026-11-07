import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock";
import type { ShopCatalog } from "./catalog";
import { FrontDeskError } from "./errors";
import { createMemoryStore } from "./memory-store";
import {
  getAvailability,
  listServices,
  minutesInWords,
  parseBookArgs,
  parseCancelArgs,
  parseGetAvailabilityArgs,
  parseGetBookingArgs,
  type FrontDeskDeps,
} from "./service";
import { EXAMPLE_BOOKINGS, memoryDeps, SAT } from "./test-support";

// "Now" is Monday 9 Nov 2026, noon in New York (Hart's is closed on Mondays), so the coming Saturday
// is 14 Nov, 5 days ahead. The store holds the two example bookings on that Saturday: 10:00–10:45 and
// 15:00–15:30. Hart's seeded rules: 2 hours' lead time, 30 days ahead, 6 days for a service with a
// deposit (haircut, haircut-beard; beard-trim has none).
const deps: FrontDeskDeps = memoryDeps({ initialBookings: EXAMPLE_BOOKINGS });

async function rejection(promise: Promise<unknown>): Promise<FrontDeskError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FrontDeskError);
    return err as FrontDeskError;
  }
  throw new Error("expected a FrontDeskError");
}

describe("in-memory catalog", () => {
  it("encodes lunch as a gap in dana's hours: 09:00–12:00 and 12:30–17:00, Tue–Sat", async () => {
    const [dana] = await deps.catalog.getStaffHours("harts");
    expect(dana.staffId).toBe("dana");
    expect(dana.staffName).toBe("Dana");
    expect(dana.weekly).toHaveLength(10);
    for (const weekday of [2, 3, 4, 5, 6]) {
      expect(dana.weekly.filter((w) => w.weekday === weekday)).toEqual([
        { weekday, open: "09:00", close: "12:00" },
        { weekday, open: "12:30", close: "17:00" },
      ]);
    }
  });

  it("returns only active bookings as busy time, never lunch", async () => {
    const busy = await deps.catalog.getBusyIntervals("harts", {
      start: new Date("2026-11-10T00:00:00-05:00"),
      end: new Date("2026-11-15T00:00:00-05:00"),
    });
    expect(busy.map((b) => [b.start.toISOString(), b.end.toISOString()])).toEqual([
      ["2026-11-14T15:00:00.000Z", "2026-11-14T15:45:00.000Z"],
      ["2026-11-14T20:00:00.000Z", "2026-11-14T20:30:00.000Z"],
    ]);
    expect(busy.every((b) => b.staffId === "dana")).toBe(true);
  });

  it("does not count cancelled bookings as busy", async () => {
    const store = createMemoryStore({
      initialBookings: [{ ...EXAMPLE_BOOKINGS[0], status: "cancelled" }],
    });
    expect(await store.getBusyIntervals("harts", { start: new Date(SAT.from), end: new Date(SAT.to) })).toEqual([]);
  });

  // Contract every ShopCatalog (memory and Postgres) must meet: an interval that began before
  // range.start but is still running overlaps the range and must be returned.
  it("returns busy intervals that started before the range but overlap it", async () => {
    const busy = await deps.catalog.getBusyIntervals("harts", {
      start: new Date("2026-11-14T10:20:00-05:00"),
      end: new Date("2026-11-14T11:00:00-05:00"),
    });
    expect(busy.map((b) => [b.start.toISOString(), b.end.toISOString()])).toEqual([
      ["2026-11-14T15:00:00.000Z", "2026-11-14T15:45:00.000Z"], // the 10:00–10:45 booking
    ]);
  });

  it("does not return intervals that only touch the range edge (half-open)", async () => {
    const busy = await deps.catalog.getBusyIntervals("harts", {
      start: new Date("2026-11-14T10:45:00-05:00"), // the 10:00–10:45 booking ends here
      end: new Date("2026-11-14T15:00:00-05:00"), // the 15:00–15:30 booking starts here
    });
    expect(busy).toEqual([]);
  });

  it("knows nothing about other shops", async () => {
    expect(await deps.catalog.getShop("nope")).toBeNull();
    expect(await deps.catalog.listServices("nope")).toEqual([]);
  });
});

describe("listServices", () => {
  it("returns Hart's Barbers and its three services in cents", async () => {
    expect(await listServices(deps, "harts")).toEqual({
      shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
      services: [
        { id: "haircut", name: "Haircut", durationMin: 30, priceCents: 3500, depositCents: 1000 },
        { id: "beard-trim", name: "Beard trim", durationMin: 15, priceCents: 1500, depositCents: 0 },
        { id: "haircut-beard", name: "Haircut + beard trim", durationMin: 45, priceCents: 4500, depositCents: 1000 },
      ],
    });
  });

  it("is not_found for an unknown shop", async () => {
    expect((await rejection(listServices(deps, "nope"))).code).toBe("not_found");
  });
});

describe("parseGetAvailabilityArgs", () => {
  const ok = { service_id: "haircut", ...SAT };

  it("passes valid arguments through and drops unknown ones", () => {
    expect(parseGetAvailabilityArgs({ ...ok, limit: 5, extra: true })).toEqual({ ...ok, limit: 5 });
  });

  it("treats limit null as omitted", () => {
    expect(parseGetAvailabilityArgs({ ...ok, limit: null })).toEqual(ok);
  });

  it.each<[string, unknown, string]>([
    ["missing service_id", { from: SAT.from, to: SAT.to }, "service_id"],
    ["empty service_id", { ...ok, service_id: " " }, "service_id"],
    ["numeric service_id", { ...ok, service_id: 5 }, "service_id"],
    ["missing from", { service_id: "haircut", to: SAT.to }, "from"],
    ["numeric to", { ...ok, to: 1731560400 }, "to"],
    ["string limit", { ...ok, limit: "5" }, "limit"],
    ["no arguments", undefined, "service_id"],
  ])("rejects %s with invalid_request naming the field", (_label, raw, field) => {
    let caught: unknown;
    try {
      parseGetAvailabilityArgs(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FrontDeskError);
    expect((caught as FrontDeskError).code).toBe("invalid_request");
    expect((caught as FrontDeskError).details).toMatchObject({ field });
  });
});

describe("getAvailability on the coming Saturday", () => {
  it("skips the lunch block and both example bookings", async () => {
    const { slots, truncated } = await getAvailability(deps, "harts", {
      service_id: "haircut",
      ...SAT,
      limit: 50,
    });
    const times = slots.map((s) => s.start.slice(11, 16));

    // Booking 10:00–10:45 blocks 9:45, 10:00, 10:15, 10:30.
    for (const t of ["09:45", "10:00", "10:15", "10:30"]) expect(times).not.toContain(t);
    // Lunch 12:00–12:30 blocks 11:45, 12:00, 12:15.
    for (const t of ["11:45", "12:00", "12:15"]) expect(times).not.toContain(t);
    // Booking 15:00–15:30 blocks 14:45, 15:00, 15:15.
    for (const t of ["14:45", "15:00", "15:15"]) expect(times).not.toContain(t);
    // Neighbours stay open.
    for (const t of ["09:30", "10:45", "11:30", "12:30", "14:30", "15:30", "16:30"]) {
      expect(times).toContain(t);
    }
    expect(slots).toHaveLength(31 - 10);
    expect(truncated).toBe(false);
    expect(slots.find((s) => s.start.endsWith("T14:30:00-05:00"))?.display).toBe("Sat 14 Nov, 2:30 pm EST");
  });

  it("sees a booking that starts right after a short window ends", async () => {
    // Window ends 09:50; the 09:45 haircut would run into the 10:00 booking.
    const { slots } = await getAvailability(deps, "harts", {
      service_id: "haircut",
      from: "2026-11-14T09:30:00-05:00",
      to: "2026-11-14T09:50:00-05:00",
    });
    expect(slots.map((s) => s.start)).toEqual(["2026-11-14T09:30:00-05:00"]);
  });

  it("respects a booking that is already running when the window starts", async () => {
    const { slots } = await getAvailability(deps, "harts", {
      service_id: "haircut",
      from: "2026-11-14T10:20:00-05:00",
      to: "2026-11-14T11:30:00-05:00",
    });
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(["10:45", "11:00", "11:15"]);
  });

  it("is not_found with a next_action for an unknown service", async () => {
    const err = await rejection(getAvailability(deps, "harts", { service_id: "perm", ...SAT }));
    expect(err.code).toBe("not_found");
    expect(err.nextAction).toMatch(/list_services/);
    expect(err.details).toMatchObject({ valid_service_ids: ["haircut", "beard-trim", "haircut-beard"] });
  });

  it("is invalid_request for a date without an offset", async () => {
    const err = await rejection(
      getAvailability(deps, "harts", { service_id: "haircut", from: "2026-11-14", to: SAT.to }),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field: "from" });
  });

  it("rejects a 15-day window before touching the catalog", async () => {
    const calls: string[] = [];
    const spy: ShopCatalog = new Proxy(deps.catalog, {
      get: (target, prop: keyof ShopCatalog) => {
        calls.push(String(prop));
        return target[prop];
      },
    });
    const err = await rejection(
      getAvailability({ ...deps, catalog: spy }, "harts", {
        service_id: "haircut",
        from: "2026-11-10T00:00:00-05:00",
        to: "2026-11-25T00:00:00-05:00",
      }),
    );
    expect(err.code).toBe("invalid_request");
    expect(calls).toEqual([]);
  });

  it("never offers times before now", async () => {
    const { slots } = await getAvailability(deps, "harts", {
      service_id: "beard-trim",
      from: "2026-11-07T00:00:00-05:00", // last Saturday
      to: "2026-11-08T00:00:00-05:00",
    });
    expect(slots).toEqual([]);
  });
});

describe("getAvailability under the shop's rules", () => {
  const TUESDAY = { from: "2026-11-10T00:00:00-05:00", to: "2026-11-11T00:00:00-05:00" };
  const tuesdayClock = (hhmm: string) => fixedClock(new Date(`2026-11-10T${hhmm}:00-05:00`));
  const starts = async (d: FrontDeskDeps, service_id: string, window: { from: string; to: string }) =>
    (await getAvailability(d, "harts", { service_id, ...window, limit: 50 })).slots.map((s) => s.start);

  it("offers nothing inside the 2-hour lead time on a working day", async () => {
    // 10:00 + 2 h = 12:00, which is lunch: the first start is 12:30.
    const at10 = await starts(memoryDeps({ clock: tuesdayClock("10:00") }), "beard-trim", TUESDAY);
    expect(at10[0]).toBe("2026-11-10T12:30:00-05:00");
    expect(at10.every((s) => s >= "2026-11-10T12:00:00-05:00")).toBe(true);
  });

  it("rounds now + lead time up to the 15-minute grid", async () => {
    // 09:07 + 2 h = 11:07 → 11:15.
    expect((await starts(memoryDeps({ clock: tuesdayClock("09:07") }), "beard-trim", TUESDAY))[0]).toBe(
      "2026-11-10T11:15:00-05:00",
    );
    // A window that ends before now + lead time has nothing.
    const early = await starts(memoryDeps({ clock: tuesdayClock("09:07") }), "beard-trim", {
      from: TUESDAY.from,
      to: "2026-11-10T11:15:00-05:00",
    });
    expect(early).toEqual([]);
  });

  it("cuts services with a deposit at the 6-day deposit horizon, but not a beard trim", async () => {
    const d = memoryDeps();
    const nextTuesday = { from: "2026-11-17T00:00:00-05:00", to: "2026-11-18T00:00:00-05:00" };
    expect(await starts(d, "haircut", nextTuesday)).toEqual([]);
    expect(await starts(d, "haircut-beard", nextTuesday)).toEqual([]);
    expect((await starts(d, "beard-trim", nextTuesday))[0]).toBe("2026-11-17T09:00:00-05:00");

    // Saturday 14 Nov is inside the deposit horizon (it ends Sun 15 Nov at noon; the shop is closed
    // Sunday and Monday), so a haircut's last offered start that week is Saturday 16:30.
    const haircuts = await starts(d, "haircut", { from: SAT.from, to: "2026-11-18T00:00:00-05:00" });
    expect(haircuts.at(-1)).toBe("2026-11-14T16:30:00-05:00");
  });

  it("offers nothing while the shop is paused", async () => {
    const paused = memoryDeps({ policies: { paused: true } });
    for (const service_id of ["haircut", "beard-trim"]) {
      expect(await getAvailability(paused, "harts", { service_id, ...SAT })).toEqual({ slots: [], truncated: false });
    }
  });

  it("still rejects bad arguments while paused", async () => {
    const paused = memoryDeps({ policies: { paused: true } });
    expect((await rejection(getAvailability(paused, "harts", { service_id: "perm", ...SAT }))).code).toBe("not_found");
    expect(
      (await rejection(getAvailability(paused, "harts", { service_id: "haircut", from: SAT.to, to: SAT.from }))).code,
    ).toBe("invalid_request");
  });

  it("removes the starts a blocked time covers, including ones that would run into it", async () => {
    const d = memoryDeps({
      initialBlocks: [
        {
          staffId: "dana",
          start: new Date("2026-11-14T13:00:00-05:00"),
          end: new Date("2026-11-14T15:00:00-05:00"),
          reason: "Dentist",
        },
      ],
    });
    const times = (await starts(d, "haircut", SAT)).map((s) => s.slice(11, 16));
    for (const t of ["12:45", "13:00", "13:30", "14:00", "14:45"]) expect(times).not.toContain(t);
    for (const t of ["12:30", "15:00", "16:30"]) expect(times).toContain(t);
  });
});

describe("tool argument parsing", () => {
  const book = { service_id: "haircut", start: "2026-11-14T14:30:00-05:00", customer_name: " Maya " };

  it("parseBookArgs trims the name and requires an idempotency_key", () => {
    expect(parseBookArgs({ ...book, idempotency_key: "abcd-1234" })).toEqual({
      ...book,
      customer_name: "Maya",
      idempotency_key: "abcd-1234",
    });
    expect(() => parseBookArgs(book)).toThrow(FrontDeskError);
  });

  it("parseGetBookingArgs and parseCancelArgs require a booking_id; cancel also an idempotency_key", () => {
    expect(parseGetBookingArgs({ booking_id: " abc " })).toEqual({ booking_id: "abc" });
    expect(parseCancelArgs({ booking_id: "abc", idempotency_key: "abcd-1234" })).toEqual({
      booking_id: "abc",
      idempotency_key: "abcd-1234",
    });
    for (const [parse, raw, field] of [
      [parseGetBookingArgs, {}, "booking_id"],
      [parseCancelArgs, { idempotency_key: "abcd-1234" }, "booking_id"],
      [parseCancelArgs, { booking_id: "abc" }, "idempotency_key"],
    ] as const) {
      let caught: unknown;
      try {
        parse(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FrontDeskError);
      expect((caught as FrontDeskError).details).toMatchObject({ field });
    }
  });
});

describe("minutesInWords", () => {
  it.each<[number, string]>([
    [0, "0 minutes"],
    [1, "1 minute"],
    [45, "45 minutes"],
    [60, "1 hour"],
    [90, "1 hour 30 minutes"],
    [120, "2 hours"],
    [1440, "1 day"],
    [10_080, "7 days"],
  ])("%i minutes is %s", (minutes, words) => {
    expect(minutesInWords(minutes)).toBe(words);
  });
});
