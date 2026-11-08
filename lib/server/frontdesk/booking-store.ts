import { DateTime } from "luxon";
import type {
  Booking,
  BookingActor,
  BookingEvent,
  BookingEventType,
  BookingStatus,
  Mandate,
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
  /** When the hold lapses (decide()'s approveBy). */
  approveBy: Date;
  /** SHA-256 hex of the approval link's token. The token itself is never stored. */
  approvalTokenHash: string;
  /** The person's limits as validated by book, or null. */
  mandate: Mandate | null;
};

// ---- Ring 1b: consent records ----

/** An approval request (one per booking), found by its token's hash. */
export type ApprovalRecord = {
  bookingId: string;
  /** null until the person approves or declines. */
  decision: "approved" | "declined" | null;
  /** When the hold lapses (bookings.approve_by). */
  approveBy: Date;
  /** The mandate stored on the booking, or null. */
  mandate: Mandate | null;
};

/** What answerApproval writes. */
export type ApprovalAnswer = {
  bookingId: string;
  decision: "approved" | "declined";
  /** decide()'s next status for the answer. */
  nextStatus: BookingStatus;
  /** Front Desk's clock. The booking must still be awaiting_approval with approve_by > now. */
  now: Date;
  /** The event to write (actor "customer"). */
  event: NewBookingEvent;
  /** approved only: the phone number the person gave (E.164), stored on the booking. null: none given. */
  phone?: string | null;
};

export type AnswerApprovalResult =
  | { ok: true; booking: Booking }
  /**
   * Nothing was written: the approval was already decided, or the booking is no longer
   * awaiting_approval, or its hold lapsed.
   */
  | { ok: false; reason: "not_pending" };

/** The event a transition writes. The store stamps `at` (Postgres now(), the memory store's clock). */
export type NewBookingEvent = {
  actor: BookingActor;
  type: BookingEventType;
  data: Record<string, unknown>;
};

export interface BookingStore {
  /**
   * Store a booking awaiting approval (status awaiting_approval, approve_by, mandate), its approval
   * request (approvals: booking_id, token_hash) and its "booked" event (actor "agent", data
   * { status: "awaiting_approval", agentName, mandate? }) in the same transaction. The returned
   * Booking has no `approval` (the store can't know the token); book adds it.
   * Throws SlotTakenError if the staff member already has an awaiting_approval, awaiting_deposit or
   * confirmed booking that overlaps [start, end), lapsed holds included: expire them first
   * (expireStaleHolds). In Postgres that's the `no_overlap` exclusion constraint (SQLSTATE 23P01).
   */
  createBooking(input: NewBooking): Promise<Booking>;
  /** Bookings of any status whose [start, end) overlaps `range`, sorted by start. */
  listBookings(shopSlug: string, range: TimeRange): Promise<Booking[]>;
  /** One booking by id, or null. Any string is accepted: a malformed id is simply not found. Doesn't expire anything. */
  getBooking(id: string): Promise<Booking | null>;
  /**
   * Lazy expiry for one booking, then read it, atomically (Postgres: one statement): if it is
   * awaiting_approval with approve_by <= now, it becomes expired with an "expired" event (actor
   * "system", data { from, to, depositEffect, depositCollected: false }). Returns the booking as it is
   * afterwards, or null (any string is accepted, like getBooking). The same rule as decide()'s expire row.
   * TODO(ring-2): a scheduled job expires holds too.
   */
  refreshBooking(id: string, now: Date): Promise<Booking | null>;
  /**
   * Lazy expiry for a time range: every awaiting_approval booking of the shop overlapping `range` with
   * approve_by <= now becomes expired, each with an "expired" event, in one statement. Returns how
   * many expired. book calls it just before inserting, so a lapsed hold never blocks a new booking.
   */
  expireStaleHolds(shopSlug: string, range: TimeRange, now: Date): Promise<number>;
  /**
   * Atomically move a booking from `expectedStatus` to `nextStatus` and write `event`, in one
   * transaction, only if its status is still `expectedStatus` (Postgres: UPDATE … WHERE status =
   * expectedStatus). Returns the updated booking, or null if the status had changed (another
   * transition won) or the booking doesn't exist. Of two concurrent transitions from the same
   * status, exactly one gets a booking back.
   * Also stamps the status's timestamp with the event's time: cancelled → cancelled_at and
   * cancelled_by (= event.actor: "agent", "owner" or "customer"), completed → completed_at,
   * no_show → no_show_at.
   */
  transition(
    id: string,
    expectedStatus: BookingStatus,
    nextStatus: BookingStatus,
    event: NewBookingEvent,
  ): Promise<Booking | null>;
  /** A booking's events, oldest first (by at, then id). Empty if there are none. */
  listEvents(bookingId: string): Promise<BookingEvent[]>;
  // ---- Ring 1b: consent (approvals) ----

  /** The approval request whose token hashes to `tokenHash`, or null. Doesn't expire anything. */
  findApproval(tokenHash: string): Promise<ApprovalRecord | null>;
  /**
   * The person's answer, in one transaction: move the booking from awaiting_approval to nextStatus only
   * if approve_by > now (approved stores `phone` as customer_phone; cancelled stamps cancelled_at and
   * cancelled_by "customer"); write `event`; and mark the approval decided (decision, decided_at = now)
   * only if it wasn't. Anything that doesn't match rolls everything back.
   */
  answerApproval(input: ApprovalAnswer): Promise<AnswerApprovalResult>;
}

/** The staff member is already booked for part of that time. Another agent got there first. */
export class SlotTakenError extends Error {
  constructor(message = "That staff member already has a booking overlapping this time.") {
    super(message);
    this.name = "SlotTakenError";
  }
}

/** Statuses that hold time on the calendar (the no_overlap constraint and busy time). */
export const ACTIVE_STATUSES: readonly BookingStatus[] = ["awaiting_approval", "awaiting_deposit", "confirmed"];

/** Final statuses: nothing changes a booking after it reaches one. */
export const FINAL_STATUSES: readonly BookingStatus[] = ["cancelled", "expired", "completed", "no_show"];

/** The deposit effect of a hold expiring (decide()'s expire row), as both stores' lazy expiry records it. */
export function expiredEventData(depositCents: number): Record<string, unknown> {
  return {
    from: "awaiting_approval",
    to: "expired",
    depositEffect: depositCents > 0 ? "released" : "none",
    depositCollected: false,
  };
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
  /** true once the person approved the booking through the approval link (approvals.decision = approved). */
  customerVerified: boolean;
  /** The phone number the person gave when approving (E.164), or null. */
  customerPhone: string | null;
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
    customer: {
      displayName: r.customerName,
      verified: r.customerVerified,
      ...(r.customerPhone ? { phoneLast4: r.customerPhone.slice(-4) } : {}),
    },
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

/** A canonical (hyphenated) UUID, in either case. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id lowercased if it's a canonical UUID, else null. Both stores look booking and block ids up
 * through this, so a malformed id is simply not found (Postgres would otherwise raise 22P02).
 */
export function normalizeUuid(id: string): string | null {
  return UUID.test(id) ? id.toLowerCase() : null;
}
