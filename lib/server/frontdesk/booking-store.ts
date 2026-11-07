import { DateTime } from "luxon";
import type { Booking, BookingStatus } from "../../types/frontdesk";
import { formatDisplay } from "../engine/availability";
import type { TimeRange } from "./catalog";
import { toRfc3339 } from "./time";

// Data access for bookings. Implementations: postgres-store.ts and memory-store.ts.

/** What createBooking needs. The caller has already checked the slot against availability. */
export type NewBooking = {
  shopSlug: string;
  serviceId: string;
  staffId: string;
  /** Half-open [start, end). */
  start: Date;
  end: Date;
  /** Trimmed, 1–80 characters. */
  customerName: string;
  agentName: string;
};

export interface BookingStore {
  /**
   * Store a confirmed booking.
   * Throws SlotTakenError if the staff member already has a confirmed booking that overlaps
   * [start, end). In Postgres that's the `no_overlap` exclusion constraint (SQLSTATE 23P01).
   */
  createBooking(input: NewBooking): Promise<Booking>;
  /** Bookings of any status whose [start, end) overlaps `range`, sorted by start. */
  listBookings(shopSlug: string, range: TimeRange): Promise<Booking[]>;
}

/** The staff member is already booked for part of that time. Another agent got there first. */
export class SlotTakenError extends Error {
  constructor(message = "That staff member already has a confirmed booking overlapping this time.") {
    super(message);
    this.name = "SlotTakenError";
  }
}

/** A stored booking plus the shop and service details a Booking shows. Both stores map through this. */
export type BookingRecord = {
  id: string;
  shopSlug: string;
  serviceId: string;
  serviceName: string;
  depositCents: number;
  staffId: string;
  start: Date;
  end: Date;
  status: BookingStatus;
  customerName: string;
  agentName: string;
  createdAt: Date;
  /** The shop's IANA zone; times are shown in it. */
  timezone: string;
};

export function toBooking(r: BookingRecord): Booking {
  return {
    id: r.id,
    shopSlug: r.shopSlug,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    staffId: r.staffId,
    start: toRfc3339(r.start, r.timezone),
    end: toRfc3339(r.end, r.timezone),
    display: formatDisplay(DateTime.fromJSDate(r.start, { zone: r.timezone })),
    status: r.status,
    customer: { displayName: r.customerName, verified: false },
    agent: { name: r.agentName },
    depositCents: r.depositCents,
    createdAt: toRfc3339(r.createdAt, r.timezone),
  };
}

/** Sort by start, then id, so equal starts (two staff members) come back in a stable order. */
export function byStart(a: { start: Date; id: string }, b: { start: Date; id: string }): number {
  return a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
