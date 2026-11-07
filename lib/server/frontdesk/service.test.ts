import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock";
import type { ShopCatalog } from "./catalog";
import { FrontDeskError } from "./errors";
import { comingSaturday, createHardcodedCatalog } from "./hardcoded-catalog";
import { getAvailability, listServices, type FrontDeskDeps } from "./service";

// "Now" is Saturday 7 Nov 2026, noon in New York, so the coming Saturday is 14 Nov.
const NOW = new Date("2026-11-07T12:00:00-05:00");
const clock = fixedClock(NOW);
const deps: FrontDeskDeps = { clock, catalog: createHardcodedCatalog(clock) };

const SAT = { from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" };

async function rejection(promise: Promise<unknown>): Promise<FrontDeskError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FrontDeskError);
    return err as FrontDeskError;
  }
  throw new Error("expected a FrontDeskError");
}

describe("hard-coded catalog", () => {
  it("picks the first Saturday strictly after today", () => {
    const zone = "America/New_York";
    expect(comingSaturday(new Date("2026-11-07T12:00:00-05:00"), zone).toISODate()).toBe("2026-11-14"); // Sat
    expect(comingSaturday(new Date("2026-11-13T23:59:00-05:00"), zone).toISODate()).toBe("2026-11-14"); // Fri
    expect(comingSaturday(new Date("2026-11-08T09:00:00-05:00"), zone).toISODate()).toBe("2026-11-14"); // Sun
    // 03:00 UTC on Sat 14 Nov is still Fri 13 Nov in New York.
    expect(comingSaturday(new Date("2026-11-14T03:00:00Z"), zone).toISODate()).toBe("2026-11-14");
  });

  it("returns lunch every open day and the two example bookings on the coming Saturday", async () => {
    const busy = await deps.catalog.getBusyIntervals("harts", {
      start: new Date("2026-11-10T00:00:00-05:00"),
      end: new Date("2026-11-15T00:00:00-05:00"),
    });
    const reasons = busy.map((b) => `${b.start.toISOString()} ${b.reason}`);
    expect(reasons.filter((r) => r.endsWith("lunch"))).toHaveLength(5); // Tue–Sat
    expect(reasons.filter((r) => r.includes("booking"))).toHaveLength(2);
    expect(busy.every((b) => b.staffId === "dana")).toBe(true);
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
      getAvailability({ clock, catalog: spy }, "harts", {
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
      from: "2026-11-07T00:00:00-05:00",
      to: "2026-11-08T00:00:00-05:00",
    });
    expect(slots[0].start).toBe("2026-11-07T12:30:00-05:00"); // noon is lunch; 12:30 is next
  });
});
