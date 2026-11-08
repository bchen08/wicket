import { DateTime } from "luxon";
import type {
  Alert,
  AlertChannel,
  AlertKind,
  AlertStatus,
  Booking,
  BookingActor,
  BookingEvent,
  BookingEventType,
  BookingStatus,
  DepositState,
  Mandate,
} from "../../types/frontdesk";
import { approvalPath } from "../consent/crypto";
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
  /** The approval link's token (newApprovalToken), stored as it is so every booking response can carry the link. */
  approvalToken: string;
  /** The person's limits as validated by book, or null. */
  mandate: Mandate | null;
};

// ---- Ring 1b: consent records ----

/** An approval request (one per booking), found by its token. */
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
  /**
   * approved only: the deposit columns to set with it: awaiting_payment with the Checkout Session, its URL
   * and pay_by (the booking goes to awaiting_deposit), or not_collected (confirmed without collecting).
   */
  deposit?: DepositPatch;
};

// ---- Ring 1c: deposits ----

/** The Stripe side of a booking's deposit, for lib/server/deposits. Booking doesn't show the ids. */
export type DepositRecord = {
  state: DepositState;
  /** The Checkout Session opened on approve, or null. */
  checkoutSessionId: string | null;
  /** The PaymentIntent holding the deposit once it's paid, or null. */
  paymentIntentId: string | null;
  /** When an awaiting_deposit booking lapses, or null. */
  payBy: Date | null;
};

/** What a transition or an approval writes to a booking's deposit columns, with its status. Absent fields keep their values. */
export type DepositPatch = {
  state?: DepositState;
  checkoutSessionId?: string;
  checkoutUrl?: string;
  paymentIntentId?: string;
  payBy?: Date;
};

/** A capture or release Stripe refused (bookings.deposit_failure). */
export type DepositFailure = {
  action: "capture" | "release";
  message: string;
  at: Date;
};

/** What updateDeposit writes after money moved, or failed to. */
export type DepositOutcome = {
  /** The new state (captured, released). Absent: unchanged. */
  state?: DepositState;
  /** The failure to show, or null to clear it. Absent: unchanged. */
  failure?: DepositFailure | null;
};

export type AnswerApprovalResult =
  | { ok: true; booking: Booking }
  /**
   * Nothing was written: the approval was already decided, or the booking is no longer
   * awaiting_approval, or its hold lapsed.
   */
  | { ok: false; reason: "not_pending" };

/** An owner alert to record (the alerts table), after it was sent or failed. */
export type NewAlert = {
  shopSlug: string;
  bookingId: string;
  kind: AlertKind;
  channel: AlertChannel;
  /** The email address it went to; null for a log line. */
  recipient: string | null;
  status: AlertStatus;
  /** Why it failed; null unless status is failed. */
  error: string | null;
};

/** The event a transition writes. The store stamps `at` (Postgres now(), the memory store's clock). */
export type NewBookingEvent = {
  actor: BookingActor;
  type: BookingEventType;
  data: Record<string, unknown>;
};

export interface BookingStore {
  /**
   * Store a booking awaiting approval (status awaiting_approval, approve_by, mandate), its approval
   * request (approvals: booking_id, token) and its "booked" event (actor "agent", data
   * { status: "awaiting_approval", agentName, mandate? }) in the same transaction.
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
    /** Deposit columns to set in the same statement (e.g. confirm_deposit: held and the PaymentIntent). */
    deposit?: DepositPatch,
  ): Promise<Booking | null>;
  /** A booking's events, oldest first (by at, then id). Empty if there are none. */
  listEvents(bookingId: string): Promise<BookingEvent[]>;
  // ---- Ring 1b: consent (approvals) ----

  /** The approval request with this token, or null. Doesn't expire anything. */
  findApproval(token: string): Promise<ApprovalRecord | null>;
  /**
   * The person's answer, in one transaction: move the booking from awaiting_approval to nextStatus only
   * if approve_by > now (approved stores `phone` as customer_phone; cancelled stamps cancelled_at and
   * cancelled_by "customer"); write `event`; and mark the approval decided (decision, decided_at = now)
   * only if it wasn't. Anything that doesn't match rolls everything back. approved also writes
   * `input.deposit` (awaiting_deposit: the Checkout Session, its URL, pay_by).
   */
  answerApproval(input: ApprovalAnswer): Promise<AnswerApprovalResult>;

  // ---- Ring 1c: deposits ----

  /** The Stripe side of a booking's deposit, or null (no such booking; any string is accepted). */
  getDeposit(id: string): Promise<DepositRecord | null>;
  /**
   * After a capture or release, or a failed one: set the deposit's state and failure, and write `event`
   * (deposit.action_failed) if given, in one statement. Doesn't touch the status. Returns the booking, or
   * null if there's no such booking.
   */
  updateDeposit(id: string, outcome: DepositOutcome, event?: NewBookingEvent): Promise<Booking | null>;

  // ---- Owner alerts ----

  /** Store one alert (created_at: Postgres now(), the memory store's clock) and return it. */
  recordAlert(alert: NewAlert): Promise<Alert>;
  /** The shop's newest `limit` alerts, newest first (by created_at, then id). Empty if there are none. */
  listAlerts(shopSlug: string, limit: number): Promise<Alert[]>;
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
  /** true once the person tapped Approve on the approval link (approvals.decision = approved). */
  customerApproved: boolean;
  /** The phone number the person gave when approving (E.164), or null. */
  customerPhone: string | null;
  /** The approval link's token (approvals.token), or null for a booking without an approval request. */
  approvalToken: string | null;
  /** When the hold lapses (bookings.approve_by), or null. */
  approveBy: Date | null;
  /** bookings.deposit_state. */
  depositState: DepositState;
  /** The Checkout Session's URL (bookings.checkout_url), or null. */
  checkoutUrl: string | null;
  /** When an unpaid deposit lapses (bookings.pay_by), or null. */
  payBy: Date | null;
  /** The last capture or release Stripe refused (bookings.deposit_failure), or null. */
  depositFailure: DepositFailure | null;
  /** The shop's IANA zone; times are shown in it. */
  timezone: string;
};

/**
 * Booking.deposit for a stored record. payUrl and payBy only while the booking is awaiting its deposit;
 * actionFailed while the last capture or release failed.
 */
export function toBookingDeposit(r: BookingRecord): Booking["deposit"] {
  const awaiting = r.status === "awaiting_deposit" && r.depositState === "awaiting_payment";
  return {
    amountCents: r.depositCents,
    state: r.depositState,
    ...(awaiting && r.checkoutUrl ? { payUrl: r.checkoutUrl } : {}),
    ...(awaiting && r.payBy ? { payBy: toRfc3339(r.payBy, r.timezone) } : {}),
    ...(r.depositFailure
      ? {
          actionFailed: {
            action: r.depositFailure.action,
            message: r.depositFailure.message,
            at: toRfc3339(r.depositFailure.at, r.timezone),
          },
        }
      : {}),
  };
}

/**
 * The Booking for a stored record. While it is awaiting_approval or awaiting_deposit it carries `approval`
 * (expiresAt: approve_by, or pay_by while the deposit is due), whose url is only the path
 * ("/approve/<token>"): the store doesn't know the request's origin. The service layer puts it in front
 * (withApprovalOrigin in service.ts) before a booking leaves the server.
 */
export function toBooking(r: BookingRecord): Booking {
  const holdEnds = r.status === "awaiting_approval" ? r.approveBy : r.status === "awaiting_deposit" ? r.payBy : null;
  const approval =
    holdEnds && r.approvalToken
      ? { approval: { url: approvalPath(r.approvalToken), expiresAt: toRfc3339(holdEnds, r.timezone) } }
      : {};
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
      approved: r.customerApproved,
      verified: r.customerApproved,
      ...(r.customerPhone ? { phone: r.customerPhone } : {}),
    },
    agent: { name: r.agentName },
    depositCents: r.depositCents,
    deposit: toBookingDeposit(r),
    createdAt: toRfc3339(r.createdAt, r.timezone),
    ...approval,
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

/** A stored alert plus the shop's zone. Both stores map through this. */
export type AlertRecord = Omit<Alert, "createdAt"> & { createdAt: Date; timezone: string };

export function toAlert(r: AlertRecord): Alert {
  return {
    id: r.id,
    shopSlug: r.shopSlug,
    bookingId: r.bookingId,
    kind: r.kind,
    channel: r.channel,
    recipient: r.recipient,
    status: r.status,
    error: r.error,
    createdAt: toRfc3339(r.createdAt, r.timezone),
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
