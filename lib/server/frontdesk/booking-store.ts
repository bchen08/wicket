import { DateTime } from "luxon";
import type {
  Booking,
  BookingActor,
  BookingEvent,
  BookingEventType,
  BookingStatus,
} from "../../types/frontdesk";
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
  /** The service's deposit at booking time, in cents. Stored on the booking so later price changes don't rewrite it. */
  depositCents: number;
};

/** The event a transition writes. The store stamps `at` (Postgres now(), the memory store's clock). */
export type NewBookingEvent = {
  actor: BookingActor;
  type: BookingEventType;
  data: Record<string, unknown>;
};

/** The write tools that take an idempotency key. Keys are scoped per tool. */
export type IdempotentTool = "book" | "cancel";

export type IdempotencyScope = {
  /** The caller's idempotency_key, already validated (8–128 visible ASCII characters). */
  key: string;
  tool: IdempotentTool;
  /** sha256 hex of the normalized arguments (see lib/server/frontdesk/idempotency.ts). */
  requestHash: string;
};

/** How long a key is remembered. After this it may be reused. TODO(ring-2): a job that deletes old keys. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface BookingStore {
  /**
   * Store a confirmed booking and its "booked" event (actor "agent", data { status: "confirmed",
   * agentName }) in the same transaction.
   * Throws SlotTakenError if the staff member already has an awaiting_deposit or confirmed booking
   * that overlaps [start, end). In Postgres that's the `no_overlap` exclusion constraint (SQLSTATE 23P01).
   */
  createBooking(input: NewBooking): Promise<Booking>;
  /** Bookings of any status whose [start, end) overlaps `range`, sorted by start. */
  listBookings(shopSlug: string, range: TimeRange): Promise<Booking[]>;
  /** One booking by id, or null. Any string is accepted: a malformed id is simply not found. */
  getBooking(id: string): Promise<Booking | null>;
  /**
   * Atomically move a booking from `expectedStatus` to `nextStatus` and write `event`, in one
   * transaction, only if its status is still `expectedStatus` (Postgres: UPDATE … WHERE status =
   * expectedStatus). Returns the updated booking, or null if the status had changed (another
   * transition won) or the booking doesn't exist. Of two concurrent transitions from the same
   * status, exactly one gets a booking back.
   * Also stamps the status's timestamp with the event's time: cancelled → cancelled_at and
   * cancelled_by (= event.actor, "agent" or "owner"), completed → completed_at, no_show → no_show_at.
   */
  transition(
    id: string,
    expectedStatus: BookingStatus,
    nextStatus: BookingStatus,
    event: NewBookingEvent,
  ): Promise<Booking | null>;
  /** A booking's events, oldest first (by at, then id). Empty if there are none. */
  listEvents(bookingId: string): Promise<BookingEvent[]>;
  /**
   * Run `action` at most once per (scope.key, scope.tool) within IDEMPOTENCY_TTL_MS.
   * - New key (or one older than the TTL): runs `action(store)`. If it resolves, its result is saved
   *   with requestHash and returned with replayed: false. If it throws, nothing is saved and the
   *   error propagates, so a retry runs the action again.
   * - Same key, same requestHash: returns a JSON copy of the saved result with replayed: true, without
   *   running `action`.
   * - Same key, different requestHash: throws FrontDeskError("idempotency_conflict").
   * Concurrent calls with the same key are serialized: the second waits for the first to finish,
   * then replays (or, if the first threw, runs). `T` must survive a JSON round trip.
   * Postgres: one transaction; `action` gets a store bound to it, so the action's writes commit or
   * roll back together with the key.
   */
  idempotent<T>(
    scope: IdempotencyScope,
    action: (store: BookingStore) => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }>;
}

/** The staff member is already booked for part of that time. Another agent got there first. */
export class SlotTakenError extends Error {
  constructor(message = "That staff member already has a booking overlapping this time.") {
    super(message);
    this.name = "SlotTakenError";
  }
}

/** Statuses that hold time on the calendar (the no_overlap constraint and busy time). */
export const ACTIVE_STATUSES: readonly BookingStatus[] = ["awaiting_deposit", "confirmed"];

/** Final statuses: nothing changes a booking after it reaches one. */
export const FINAL_STATUSES: readonly BookingStatus[] = ["cancelled", "expired", "completed", "no_show"];

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

/** A stored event plus the shop's zone. Both stores map through this. */
export type EventRecord = {
  id: string;
  bookingId: string;
  at: Date;
  actor: BookingActor;
  type: BookingEventType;
  data: Record<string, unknown>;
  timezone: string;
};

export function toBookingEvent(r: EventRecord): BookingEvent {
  return {
    id: r.id,
    bookingId: r.bookingId,
    at: toRfc3339(r.at, r.timezone),
    actor: r.actor,
    type: r.type,
    data: r.data,
  };
}

/** Sort by start, then id, so equal starts (two staff members) come back in a stable order. */
export function byStart(a: { start: Date; id: string }, b: { start: Date; id: string }): number {
  return a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
