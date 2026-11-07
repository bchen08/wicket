import type { BookingStatus, Service, Shop } from "../../types/frontdesk";
import type { Clock } from "../clock";
import {
  byStart,
  SlotTakenError,
  toBooking,
  type BookingRecord,
  type BookingStore,
  type NewBooking,
} from "./booking-store";
import type { ShopCatalog, StaffHours, TimeRange, WeeklyHours } from "./catalog";

// In-memory ShopCatalog + BookingStore, seeded like supabase/seed.sql. Used by the tests and by
// local development when DATABASE_URL is unset. Enforces the same no-overlap rule as the
// Postgres `no_overlap` constraint. Data lives only as long as the process.

type StaffSeed = { id: string; shopSlug: string; name: string; weekly: WeeklyHours[] };

const OPEN_DAYS = [2, 3, 4, 5, 6] as const; // Tue–Sat (ISO weekdays)

/** Keep in step with supabase/seed.sql. */
export const SEED: {
  shops: Shop[];
  services: Record<string, Service[]>;
  staff: StaffSeed[];
} = {
  shops: [{ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" }],
  services: {
    harts: [
      { id: "haircut", name: "Haircut", durationMin: 30, priceCents: 3500, depositCents: 1000 },
      { id: "beard-trim", name: "Beard trim", durationMin: 15, priceCents: 1500, depositCents: 0 },
      { id: "haircut-beard", name: "Haircut + beard trim", durationMin: 45, priceCents: 4500, depositCents: 1000 },
    ],
  },
  staff: [
    {
      id: "dana",
      shopSlug: "harts",
      name: "Dana",
      // Lunch 12:00–12:30 is the gap between the two windows.
      weekly: OPEN_DAYS.flatMap((weekday) => [
        { weekday, open: "09:00", close: "12:00" },
        { weekday, open: "12:30", close: "17:00" },
      ]),
    },
  ],
};

/** A booking to preload, for tests (e.g. a cancelled one). */
export type InitialBooking = NewBooking & { status?: BookingStatus; createdAt?: Date };

export type MemoryStoreOptions = {
  /** Stamps createdAt. Defaults to real time. */
  clock?: Clock;
  /** Bookings that exist before the first call. Not checked for overlaps. */
  initialBookings?: InitialBooking[];
};

type StoredBooking = Omit<BookingRecord, "serviceName" | "depositCents" | "timezone">;

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function createMemoryStore(options: MemoryStoreOptions = {}): ShopCatalog & BookingStore {
  const now = () => options.clock?.now() ?? new Date();
  const bookings: StoredBooking[] = [];

  const shopOf = (slug: string) => SEED.shops.find((s) => s.slug === slug);

  function record(b: StoredBooking): BookingRecord {
    const shop = shopOf(b.shopSlug);
    const service = SEED.services[b.shopSlug]?.find((s) => s.id === b.serviceId);
    if (!shop || !service) throw new Error(`Unknown shop or service: ${b.shopSlug}/${b.serviceId}`);
    return {
      ...b,
      serviceName: service.name,
      depositCents: service.depositCents,
      timezone: shop.timezone,
    };
  }

  function insert(input: InitialBooking): StoredBooking {
    const stored: StoredBooking = {
      id: crypto.randomUUID(),
      shopSlug: input.shopSlug,
      serviceId: input.serviceId,
      staffId: input.staffId,
      start: new Date(input.start.getTime()),
      end: new Date(input.end.getTime()),
      status: input.status ?? "confirmed",
      customerName: input.customerName,
      agentName: input.agentName,
      createdAt: input.createdAt ?? now(),
    };
    record(stored); // same foreign keys as Postgres: the shop and service must exist
    bookings.push(stored);
    return stored;
  }

  for (const b of options.initialBookings ?? []) insert(b);

  return {
    async getShop(slug) {
      const shop = shopOf(slug);
      return shop ? { ...shop } : null;
    },

    async listServices(slug) {
      return (SEED.services[slug] ?? []).map((s) => ({ ...s }));
    },

    async getStaffHours(slug): Promise<StaffHours[]> {
      return SEED.staff
        .filter((s) => s.shopSlug === slug)
        .map((s) => ({ staffId: s.id, staffName: s.name, weekly: s.weekly.map((w) => ({ ...w })) }));
    },

    async getBusyIntervals(slug, range) {
      return bookings
        .filter((b) => b.shopSlug === slug && b.status === "confirmed" && overlaps(b, range))
        .sort(byStart)
        .map((b) => ({
          staffId: b.staffId,
          start: new Date(b.start.getTime()),
          end: new Date(b.end.getTime()),
          reason: `booking ${b.id}`,
        }));
    },

    async createBooking(input) {
      if (!(input.start < input.end)) throw new Error("A booking must end after it starts.");
      // Mirrors: exclude using gist (staff_id with =, during with &&) where (status = 'confirmed')
      const clash = bookings.some(
        (b) => b.status === "confirmed" && b.staffId === input.staffId && overlaps(b, input),
      );
      if (clash) throw new SlotTakenError();
      return toBooking(record(insert(input)));
    },

    async listBookings(shopSlug, range) {
      return bookings
        .filter((b) => b.shopSlug === shopSlug && overlaps(b, range))
        .sort(byStart)
        .map((b) => toBooking(record(b)));
    },
  };
}
