import type { BlockedTime, Policies, Service, Shop, WeeklyHours } from "../../types/frontdesk";
import { toRfc3339 } from "./time";

// Data access for shops. Callers depend only on this interface. Implementations:
// postgres-store.ts (production) and memory-store.ts (tests, local dev without a database).

export type { WeeklyHours };

/** A half-open span of time [start, end). */
export type TimeRange = {
  start: Date;
  end: Date;
};

/** When a staff member normally works. A break (e.g. lunch) is a gap between two windows on the same day. */
export type StaffHours = {
  staffId: string;
  /** Display name, e.g. "Dana". Used in booking confirmations; falls back to staffId. */
  staffName?: string;
  weekly: WeeklyHours[];
};

/** Time a staff member can't be booked. Half-open [start, end). */
export type BusyInterval = TimeRange & {
  staffId: string;
  /**
   * What makes it busy. "booking": an awaiting_deposit or confirmed booking (booking over it is
   * slot_taken). "block": a blocked time such as a holiday (booking over it is outside_hours).
   * Omitted means "booking".
   */
  kind?: "booking" | "block";
  /** Why it's busy. For debugging only; never shown to agents. */
  reason?: string;
};

/** A blocked time to store. Half-open [start, end). */
export type NewBlock = TimeRange & {
  staffId: string;
  /** At most 200 characters; "" for none. */
  reason: string;
};

/** Fields an owner can change on a service. */
export type ServicePatch = Partial<Pick<Service, "name" | "durationMin" | "priceCents" | "depositCents">>;

/** createService was given an id the shop already uses. */
export class DuplicateServiceError extends Error {
  constructor(readonly serviceId: string) {
    super(`The shop already has a service with id "${serviceId}".`);
    this.name = "DuplicateServiceError";
  }
}

export interface ShopCatalog {
  /** The shop, or null if no shop has this slug. */
  getShop(slug: string): Promise<Shop | null>;
  /** The shop's services in display order. Empty if the shop doesn't exist. */
  listServices(slug: string): Promise<Service[]>;
  /** Regular weekly hours for each staff member, sorted by staffId; each week sorted by weekday, then open. Empty if the shop doesn't exist. */
  getStaffHours(slug: string): Promise<StaffHours[]>;
  /**
   * Busy time overlapping `range` (half-open on both sides), sorted by start: bookings whose status is
   * awaiting_deposit or confirmed (kind "booking") and blocked times (kind "block").
   */
  getBusyIntervals(slug: string, range: TimeRange): Promise<BusyInterval[]>;
  /**
   * The shop's policies, or null if it has no policies row (or doesn't exist). Callers fall back to
   * DEFAULT_POLICIES (lib/server/frontdesk/policies.ts) for an existing shop without a row.
   */
  getPolicies(slug: string): Promise<Policies | null>;

  // ---- Owner writes. Callers check that the shop exists first. ----

  /** Insert or replace the shop's whole policies row. Returns what was stored. */
  savePolicies(slug: string, policies: Policies): Promise<Policies>;
  /**
   * Replace one staff member's entire week, atomically. The caller has validated `weekly`.
   * Returns false (and changes nothing) if the staff member isn't in the shop.
   */
  replaceWeeklyHours(slug: string, staffId: string, weekly: WeeklyHours[]): Promise<boolean>;
  /** Blocked times of the shop's staff overlapping `range`, sorted by start, then id. */
  listBlocks(slug: string, range: TimeRange): Promise<BlockedTime[]>;
  /** Store a blocked time. Returns null (and stores nothing) if the staff member isn't in the shop. */
  createBlock(slug: string, block: NewBlock): Promise<BlockedTime | null>;
  /** Delete one blocked time and return it. null if the shop has no block with that id (any string is accepted). */
  deleteBlock(slug: string, id: string): Promise<BlockedTime | null>;
  /** Add a service at the end of the display order. Throws DuplicateServiceError if the id is taken. */
  createService(slug: string, service: Service): Promise<Service>;
  /** Change some fields of a service and return it. null if the shop has no service with that id. */
  updateService(slug: string, id: string, patch: ServicePatch): Promise<Service | null>;
}

/** A stored blocked time as the contract shows it, with times in the shop's zone. Both stores map through this. */
export function toBlockedTime(
  b: { id: string; staffId: string; start: Date; end: Date; reason: string },
  timezone: string,
): BlockedTime {
  return {
    id: b.id,
    staffId: b.staffId,
    start: toRfc3339(b.start, timezone),
    end: toRfc3339(b.end, timezone),
    reason: b.reason,
  };
}
