import { DateTime } from "luxon";
import type { Service, Shop } from "../../types/frontdesk";
import type { Clock } from "../clock";
import type {
  BusyInterval,
  ShopCatalog,
  StaffHours,
  TimeRange,
} from "./catalog";

// TODO(ring-0): replace this hard-coded catalog with Postgres in the next slice.

const HARTS: Shop = {
  slug: "harts",
  name: "Hart's Barbers",
  timezone: "America/New_York",
};

const SERVICES: Record<string, Service[]> = {
  harts: [
    { id: "haircut", name: "Haircut", durationMin: 30, priceCents: 3500, depositCents: 1000 },
    { id: "beard-trim", name: "Beard trim", durationMin: 15, priceCents: 1500, depositCents: 0 },
    { id: "haircut-beard", name: "Haircut + beard trim", durationMin: 45, priceCents: 4500, depositCents: 1000 },
  ],
};

const OPEN_DAYS = [2, 3, 4, 5, 6] as const; // Tue–Sat (ISO weekdays)

const STAFF_HOURS: Record<string, StaffHours[]> = {
  harts: [
    {
      staffId: "dana",
      weekly: OPEN_DAYS.map((weekday) => ({ weekday, open: "09:00", close: "17:00" })),
    },
  ],
};

/** Daily lunch block for dana, local time. */
const LUNCH = { start: "12:00", end: "12:30" };

/**
 * Example bookings on the coming Saturday (the first Saturday strictly after today in
 * the shop's zone), so availability isn't uniform. Local times.
 */
const SATURDAY_BOOKINGS = [
  { start: "10:00", end: "10:45", reason: "booking: haircut-beard" },
  { start: "15:00", end: "15:30", reason: "booking: haircut" },
];

function at(day: DateTime, hhmm: string): DateTime {
  const [hour, minute] = hhmm.split(":").map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The first Saturday strictly after `now`'s date in `zone`, at local midnight. */
export function comingSaturday(now: Date, zone: string): DateTime {
  const today = DateTime.fromJSDate(now, { zone }).startOf("day");
  const daysAhead = ((6 - today.weekday + 7) % 7) || 7;
  return today.plus({ days: daysAhead });
}

/**
 * The hard-coded catalog: one shop, Hart's Barbers. `clock` decides which Saturday
 * holds the example bookings, so FRONTDESK_NOW moves them too.
 */
export function createHardcodedCatalog(clock: Clock): ShopCatalog {
  return {
    async getShop(slug) {
      return slug === HARTS.slug ? { ...HARTS } : null;
    },

    async listServices(slug) {
      return (SERVICES[slug] ?? []).map((s) => ({ ...s }));
    },

    async getStaffHours(slug) {
      return (STAFF_HOURS[slug] ?? []).map((s) => ({
        staffId: s.staffId,
        weekly: s.weekly.map((w) => ({ ...w })),
      }));
    },

    async getBusyIntervals(slug, range) {
      if (slug !== HARTS.slug) return [];
      const zone = HARTS.timezone;
      const busy: BusyInterval[] = [];

      // Lunch on every open day touched by the range (pad a day each side for zone edges).
      const first = DateTime.fromJSDate(range.start, { zone }).startOf("day").minus({ days: 1 });
      const last = DateTime.fromJSDate(range.end, { zone }).startOf("day").plus({ days: 1 });
      for (let day = first; day <= last; day = day.plus({ days: 1 })) {
        if (!(OPEN_DAYS as readonly number[]).includes(day.weekday)) continue;
        busy.push({
          staffId: "dana",
          start: at(day, LUNCH.start).toJSDate(),
          end: at(day, LUNCH.end).toJSDate(),
          reason: "lunch",
        });
      }

      const saturday = comingSaturday(clock.now(), zone);
      for (const b of SATURDAY_BOOKINGS) {
        busy.push({
          staffId: "dana",
          start: at(saturday, b.start).toJSDate(),
          end: at(saturday, b.end).toJSDate(),
          reason: b.reason,
        });
      }

      return busy
        .filter((b) => overlaps(b, range))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    },
  };
}
