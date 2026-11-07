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
import type { ShopCatalog, TimeRange } from "./catalog";
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

/** A 6-digit code sent to a phone for an approval. Times come from Front Desk's clock. */
export type ChallengeRecord = {
  /** Increasing: the latest code for a booking has the highest id. */
  id: string;
  bookingId: string;
  /** HMAC-SHA256(PHONE_HMAC_PEPPER, E.164 number), hex. */
  phoneHmac: string;
  phoneLast4: string;
  /** SHA-256 of the code, hex. */
  codeHash: string;
  expiresAt: Date;
  /** Approve attempts made against this code so far. */
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
};

/** What createChallenge stores, and the send limits it enforces. */
export type NewChallenge = {
  bookingId: string;
  phoneHmac: string;
  phoneLast4: string;
  codeHash: string;
  expiresAt: Date;
  /** Front Desk's clock: the new row's created_at, and the end of the limit window. */
  now: Date;
  limits: {
    /** Most codes per phone (phone_hmac) in the window, across all bookings. */
    perPhone: number;
    /** Most codes per booking (i.e. per approval link) in the window. */
    perBooking: number;
    /** The sliding window, in milliseconds. */
    windowMs: number;
  };
};

export type CreateChallengeResult =
  | { ok: true; challenge: ChallengeRecord }
  /** A limit is reached: nothing was stored. retryAfterMs: until the oldest send in the window ages out. */
  | { ok: false; limit: "phone" | "booking"; retryAfterMs: number };

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
  /** approved only: the code that proved the phone. It's consumed in the same transaction. */
  challengeId?: string;
  /** approved only: who the person is, upserted by phoneHmac and linked to the booking. */
  customer?: { phoneHmac: string; phoneLast4: string; displayName: string };
};

export type AnswerApprovalResult =
  | { ok: true; booking: Booking }
  /**
   * Nothing was written. Checked in this order: `not_pending` if the approval was already decided;
   * `code_used` if the challenge was already consumed (or isn't this booking's); `not_pending` if the
   * booking is no longer awaiting_approval or its hold lapsed.
   */
  | { ok: false; reason: "code_used" | "not_pending" };

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

/**
 * What an idempotent action works with: the bookings AND the shop catalog, both bound to the
 * idempotency transaction in Postgres. The action must read through it (not deps.catalog): reads on
 * the root client would each need a second pooled connection while the transaction holds one, so
 * as many concurrent writes as the pool has connections could wait on each other forever.
 */
export type IdempotentStore = BookingStore & ShopCatalog;

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
   * many expired. book calls it inside its transaction before inserting, so a lapsed hold never blocks
   * a new booking.
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
   * Postgres: one transaction; `action` gets a store (bookings and catalog) bound to it, so the
   * action's writes commit or roll back together with the key, and its reads use the connection the
   * transaction already holds (see IdempotentStore).
   */
  idempotent<T>(
    scope: IdempotencyScope,
    action: (store: IdempotentStore) => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }>;

  // ---- Ring 1b: consent (approvals, codes, customers) ----

  /** The approval request whose token hashes to `tokenHash`, or null. Doesn't expire anything. */
  findApproval(tokenHash: string): Promise<ApprovalRecord | null>;
  /** The booking's latest code (highest id), or null if none was sent. */
  latestChallenge(bookingId: string): Promise<ChallengeRecord | null>;
  /**
   * Store a new code, unless a send limit is reached: at most limits.perPhone codes for this
   * phoneHmac and limits.perBooking for this booking with created_at in (now − windowMs, now]. The
   * count and the insert are atomic per booking and per phone (Postgres: the approval row is locked,
   * plus an advisory lock on the phone), so concurrent sends can't exceed a limit.
   */
  createChallenge(input: NewChallenge): Promise<CreateChallengeResult>;
  /**
   * Count one approve attempt against a code, atomically, only while it's usable: not consumed,
   * expires_at > now, and attempts < maxAttempts. Returns the attempts after counting this one, or null
   * (nothing counted) if it wasn't usable.
   */
  recordCodeAttempt(challengeId: string, now: Date, maxAttempts: number): Promise<number | null>;
  /**
   * The person's answer, in one transaction: (approved) consume the challenge if it's still unconsumed,
   * upsert the customer by phoneHmac (display_name and phone_last4 updated) and link it to the booking;
   * move the booking from awaiting_approval to nextStatus only if approve_by > now (cancelled stamps
   * cancelled_at and cancelled_by "customer"); write `event`; and mark the approval decided (decision,
   * decided_at = now) only if it wasn't. Anything that doesn't match rolls everything back.
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
  /** The verified customer's phone_last4, or null if nobody has approved the booking. */
  customerPhoneLast4: string | null;
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
    customer:
      r.customerPhoneLast4 === null
        ? { displayName: r.customerName, verified: false }
        : { displayName: r.customerName, verified: true, phoneLast4: r.customerPhoneLast4 },
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
