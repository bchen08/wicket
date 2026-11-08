// Shared contract for Front Desk: the MCP tools at /api/mcp and the /api/shops/* routes the UI reads.
// The UI must import these types instead of describing the shape itself.
// Money is always an integer number of cents. Instants are RFC 3339 strings with an offset.

import type { BookingDeposit, DepositsMode } from "./deposits";

export type { BookingDeposit, DepositsMode, DepositState } from "./deposits";
// The web booking API's shapes (plain HTTP booking for agents without MCP, and the booking page).
export type * from "./web-booking";

/** A business that takes bookings. */
export type Shop = {
  /** Stable URL-safe id, e.g. "harts". */
  slug: string;
  /** Display name, e.g. "Hart's Barbers". */
  name: string;
  /** IANA time zone the shop operates in, e.g. "America/New_York". */
  timezone: string;
};

/** Something a shop sells that takes time on the calendar. */
export type Service = {
  /** Stable id within the shop, e.g. "haircut". */
  id: string;
  name: string;
  /** Length of the appointment in minutes. */
  durationMin: number;
  /** Full price in integer cents (3500 = $35.00). */
  priceCents: number;
  /** Deposit taken at booking, in integer cents. 0 = no deposit. */
  depositCents: number;
};

/** One bookable start time for one staff member. */
export type Slot = {
  /** RFC 3339 with the shop's offset, e.g. "2026-11-14T14:30:00-05:00". */
  start: string;
  /** RFC 3339 with the shop's offset; start + the service's duration. */
  end: string;
  /** Staff member who would take the appointment. */
  staffId: string;
  /** Human-readable start in the shop's time zone, e.g. "Sat 14 Nov, 2:30 pm EST". */
  display: string;
};

/**
 * Every error carries a `next_action` the caller (usually an AI agent) should follow.
 *
 * - `invalid_request`: the arguments are wrong; fix them as next_action says. Owner actions that the
 *   booking's state doesn't allow (e.g. completing a cancelled booking) are also invalid_request.
 * - `not_found`: no such shop, service, staff member or blocked time.
 * - `slot_taken`: someone else booked that time first. details.alternatives has up to 3 nearby Slots.
 * - `outside_hours`: not a bookable time for that service (closed, lunch, blocked, off the 15-minute grid).
 * - `too_soon`: inside the shop's lead time. details.earliest is the earliest allowed start.
 * - `too_far`: beyond how far ahead the shop takes bookings. details.latest: starts must be before it.
 * - `paused`: the owner paused bookings. details.phone is the shop's phone number (or null).
 * - `booking_not_found`: no booking with that id at this shop.
 * - `not_cancellable`: the booking is already final, or its start has passed. details.status.
 * - `unauthorized`: an owner route without `Authorization: Bearer <OWNER_API_TOKEN>` or the fd_owner cookie, or
 *   the deployment has no OWNER_API_TOKEN set. next_action says which.
 * - `outside_mandate`: book refused a booking outside the person's mandate. details.field is
 *   "price_cap", "deposit_cap" or "window".
 * - `approval_expired`: the 10-minute hold lapsed before the person approved; the slot is free again.
 * - `approval_closed`: the approval request was already answered, or the booking was cancelled.
 * - `internal`: our fault; retry once.
 */
export type ApiErrorCode =
  | "invalid_request"
  | "not_found"
  | "slot_taken"
  | "outside_hours"
  | "too_soon"
  | "too_far"
  | "paused"
  | "booking_not_found"
  | "not_cancellable"
  | "unauthorized"
  | "outside_mandate"
  | "approval_expired"
  | "approval_closed"
  | "internal";

/** Error envelope returned by every Front Desk API surface. */
export type ApiError = {
  error: {
    code: ApiErrorCode;
    /** What went wrong, in one sentence. */
    message: string;
    /** What the caller (usually an AI agent) should do next to recover. */
    next_action: string;
    /** Machine-readable specifics, e.g. the offending field. */
    details?: Record<string, unknown>;
  };
};

// ---- Shop rules ----

/**
 * How a shop takes bookings, and where the owner's alerts go. Set by the owner through the owner routes.
 * Agents read everything but ownerEmail through get_policies (AgentPolicies).
 */
export type Policies = {
  /** Minimum minutes between now and an appointment's start. Default 120. */
  leadTimeMin: number;
  /** How many days ahead a service without a deposit can be booked. Default 30. */
  horizonDays: number;
  /** How many days ahead a service with a deposit can be booked. Default 6. */
  depositHorizonDays: number;
  /**
   * An agent cancelling at least this many hours before the start gets the deposit released;
   * cancelling later (but before the start) means the deposit is captured as a late fee. Default 24.
   */
  cancelWindowHours: number;
  /** true when the owner has paused bookings: get_availability returns nothing and book returns `paused`. */
  paused: boolean;
  /** The shop's phone number, for people to call. null if the owner hasn't set one. */
  phone: string | null;
  /** Plain-language deposit rule, to read to the customer. "" if not set. */
  depositRule: string;
  /** Plain-language late-cancellation rule. "" if not set. */
  lateCancelRule: string;
  /** Plain-language no-show rule. "" if not set. */
  noShowRule: string;
  /**
   * The owner's email address for booking alerts (Alert), e.g. "dana@example.com". null: alerts are
   * written to the log instead. Emails go out only where RESEND_API_KEY is set (production). Only the
   * owner routes show it; get_policies leaves it out.
   */
  ownerEmail: string | null;
};

/** The shop's rules as agents read them through get_policies: Policies without the owner's email. */
export type AgentPolicies = Omit<Policies, "ownerEmail">;

/** One opening window in a staff member's regular week, in the shop's local time. */
export type WeeklyHours = {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Local opening time, "HH:mm" (24-hour). */
  open: string;
  /** Local closing time, "HH:mm" (24-hour). Appointments must end by this time. */
  close: string;
};

/** A staff member's regular week. A break (e.g. lunch) is a gap between two windows on the same day. */
export type StaffWeeklyHours = {
  staffId: string;
  /** Display name, e.g. "Dana". */
  staffName: string;
  /** Sorted by weekday, then open. */
  weekly: WeeklyHours[];
};

/** Time a staff member can't be booked: a holiday or time off. Half-open [start, end). */
export type BlockedTime = {
  /** UUID. */
  id: string;
  staffId: string;
  /** RFC 3339 with the shop's offset. Inclusive. */
  start: string;
  /** RFC 3339 with the shop's offset. Exclusive. */
  end: string;
  /** Why, e.g. "Holiday". For the owner; never shown to agents. "" if none. */
  reason: string;
};

// ---- MCP tool shapes (structuredContent) ----

/** Input of the `list_services` tool. Takes no arguments. */
export type ListServicesInput = Record<string, never>;

/** structuredContent of a successful `list_services` call. */
export type ListServicesResult = {
  shop: Shop;
  services: Service[];
};

/** Input of the `get_policies` tool. Takes no arguments. */
export type GetPoliciesInput = Record<string, never>;

/** structuredContent of a successful `get_policies` call. The owner routes return PoliciesResponse instead. */
export type GetPoliciesResult = {
  shop: Shop;
  policies: AgentPolicies;
};

/** Input of the `get_availability` tool. */
export type GetAvailabilityInput = {
  /** A Service.id from list_services. */
  service_id: string;
  /** Window start, RFC 3339 with offset. Inclusive. */
  from: string;
  /** Window end, RFC 3339 with offset. Exclusive. At most 14 days after `from`. */
  to: string;
  /** Maximum slots to return, 1–50. Defaults to 20. */
  limit?: number;
};

/** structuredContent of a successful `get_availability` call. */
export type GetAvailabilityResult = {
  /** Bookable starts, earliest first. Empty when the shop is paused. */
  slots: Slot[];
  /** true if more slots exist in the window than were returned. */
  truncated: boolean;
};

// ---- Bookings ----

/**
 * Where a booking stands.
 * - `awaiting_approval`: the slot is held; the person hasn't approved yet. book creates every booking in
 *   this status, held for 10 minutes. Approving makes it confirmed; declining cancels it; letting the
 *   hold lapse expires it.
 * - `awaiting_deposit`: the person approved a booking that needs a deposit, and must pay it on Stripe
 *   Checkout (Booking.deposit.payUrl) within 30 minutes. Holds the slot. Paying confirms it; not paying
 *   in time expires it.
 * - `confirmed`: the appointment is on: the person approved it (and paid the deposit, if it needed one).
 * - `cancelled`: cancelled by the agent or the owner, or declined by the person. Frees the slot.
 * - `expired`: the person didn't approve within the 10-minute hold, or didn't pay the deposit within 30
 *   minutes of approving. Frees the slot.
 * - `completed`: the owner marked it done, after the start.
 * - `no_show`: the owner marked that the customer didn't come, after the start.
 * `awaiting_approval`, `awaiting_deposit` and `confirmed` hold the time; the other four are final.
 */
export type BookingStatus =
  | "awaiting_approval"
  | "awaiting_deposit"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "completed"
  | "no_show";

/** What the shop's policy does with the deposit when a booking changes state. */
export type DepositEffect =
  /** The booking has no deposit (depositCents is 0). */
  | "none"
  /** The customer keeps the money: any hold is dropped. */
  | "released"
  /** The shop keeps the deposit (a late cancellation or a no-show). */
  | "captured";

/**
 * Who did something to a booking. `customer` is the person approving or declining through the
 * approval link. `system` is for automatic changes (a hold that lapsed, a deposit paid or not paid in
 * time, a deposit Stripe refused to move).
 */
export type BookingActor = "agent" | "owner" | "customer" | "system";

/**
 * What happened to a booking. `booked`: the agent placed the hold. `approved` / `declined`: the person
 * answered the approval request. `expired`: the hold lapsed, or the deposit wasn't paid in time.
 * `deposit.paid`: the person paid the deposit hold, so the booking is confirmed. `deposit.action_failed`:
 * Stripe refused to capture or release the deposit (no status change; data { action, message }).
 */
export type BookingEventType =
  | "booked"
  | "approved"
  | "declined"
  | "expired"
  | "cancelled"
  | "completed"
  | "no_show"
  | "deposit.paid"
  | "deposit.action_failed";

/** One step in a booking's history. Every state change writes exactly one. */
export type BookingEvent = {
  /** Increasing id; events sort by `at`, then `id`. */
  id: string;
  bookingId: string;
  /** RFC 3339 with the shop's offset. */
  at: string;
  actor: BookingActor;
  type: BookingEventType;
  /**
   * Specifics. `booked`: { status, agentName, mandate? }. A transition: { from, to, depositEffect,
   * depositCollected }. `deposit.paid` adds checkoutSessionId and paymentIntentId. `deposit.action_failed`:
   * { action: "capture" | "release", message, paymentIntentId?, checkoutSessionId? }.
   */
  data: Record<string, unknown>;
};

/**
 * The person's limits, sent by their agent with book. The server refuses a booking outside them
 * (outside_mandate). Every field is optional; an absent field sets no limit.
 * TODO(ring-2): require a mandate once agents sign in.
 */
export type Mandate = {
  /** The most the service may cost, in integer cents. */
  priceCapCents?: number;
  /** The largest deposit the service may require, in integer cents. */
  depositCapCents?: number;
  /** The appointment, [start, end), must lie inside this window. RFC 3339 with offsets; from < to. */
  window?: { from: string; to: string };
};

/** An appointment on a shop's calendar. */
export type Booking = {
  /** UUID. */
  id: string;
  shopSlug: string;
  /** A Service.id. */
  serviceId: string;
  /** The service's name, e.g. "Haircut". */
  serviceName: string;
  /** Staff member taking the appointment. */
  staffId: string;
  /** RFC 3339 with the shop's offset, e.g. "2026-11-14T14:30:00-05:00". */
  start: string;
  /** RFC 3339 with the shop's offset; start + the service's duration. */
  end: string;
  /** Human-readable start in the shop's time zone, like Slot.display: "Sat 14 Nov, 2:30 pm EST". */
  display: string;
  status: BookingStatus;
  customer: {
    /** The name the agent gave for the customer. */
    displayName: string;
    /** true once the person tapped Approve on the approval link. */
    approved: boolean;
    /** @deprecated use approved; removed once the console reads approved (v0). */
    verified: boolean;
    /** The phone number the person gave when approving, E.164, e.g. "+14015550123". Absent if they gave none. Not checked. */
    phone?: string;
  };
  agent: {
    /** Best-effort label for the AI agent that booked: the MCP client's self-reported name. */
    name: string;
  };
  /** Deposit the service required when this booking was made, in integer cents. 0 = none. See `deposit` for where it stands. */
  depositCents: number;
  /** The deposit: how much, and where it stands (asked for, held on the card, captured, released). See BookingDeposit. */
  deposit: BookingDeposit;
  /** When the booking was made, RFC 3339. */
  createdAt: string;
  /**
   * The link the person opens to approve or decline, and when the hold lapses. Present while status is
   * awaiting_approval, in every booking response: book, get_booking, the owner bookings list and booking
   * detail. An agent that lost the link can fetch it again with get_booking; the owner can copy it.
   * Also present while awaiting_deposit: the same page then has the Pay button, and expiresAt is when the
   * deposit must be paid by (deposit.payBy).
   */
  approval?: {
    /**
     * `<origin>/approve/<token>`, where origin is the origin of the request that returned it (so it works
     * on previews and in production). Send it to the person; anyone holding it can approve or decline.
     */
    url: string;
    /**
     * When the hold lapses, RFC 3339 with the shop's offset: book time + 10 minutes, or, while awaiting_deposit,
     * approve time + 30 minutes.
     */
    expiresAt: string;
  };
};

/** Input of the `book` tool. */
export type BookInput = {
  /** A Service.id from list_services. */
  service_id: string;
  /** A Slot.start returned by get_availability. RFC 3339 with offset. */
  start: string;
  /** Who the booking is for, 1–80 characters after trimming. */
  customer_name: string;
  /** The person's limits. The server refuses a booking outside them (outside_mandate). Optional for now. */
  mandate?: Mandate;
};

/** structuredContent of a successful `book` call. booking.status is awaiting_approval, with booking.approval set. */
export type BookResult = {
  booking: Booking;
};

/** Input of the `get_booking` tool. */
export type GetBookingInput = {
  /** A Booking.id (UUID) from book. */
  booking_id: string;
};

/** structuredContent of a successful `get_booking` call. */
export type GetBookingResult = {
  booking: Booking;
};

/** Input of the `cancel` tool. */
export type CancelInput = {
  /** A Booking.id (UUID) from book. */
  booking_id: string;
};

/**
 * Result of a state change: the `cancel` tool's structuredContent, and the owner's
 * cancel / complete / no-show routes.
 */
export type BookingTransitionResult = {
  /** The booking after the change. */
  booking: Booking;
  /** What the shop's policy decides for the deposit. */
  depositEffect: DepositEffect;
  /**
   * true when real money moves: the booking had its deposit held on the card (deposit.state `held`), and
   * this change captures or releases it in Stripe. booking.deposit shows the outcome (`captured`, `released`,
   * or `actionFailed` if Stripe refused). false when no deposit was held.
   */
  depositCollected: boolean;
};

/** structuredContent of a successful `cancel` call. */
export type CancelResult = BookingTransitionResult;

// ---- HTTP routes for the UI ----

/** GET /api/shops/[shop]/services (public). */
export type ServicesResponse = {
  shop: Shop;
  services: Service[];
};

/**
 * GET /api/shops/[shop]/bookings (owner route: it includes customers' phone numbers). Bookings from 7 days
 * ago to 30 days ahead, any status, sorted by start.
 */
export type BookingsResponse = {
  shop: Shop;
  bookings: Booking[];
};

// ---- Owner session (stub; TODO(ring-2): owner sign-in by texted code replaces it) ----

/**
 * POST /api/owner/session body, as JSON. The same route also takes a plain HTML form post with a `token`
 * field (303 → /console, or → /console/unlock?error=1 on a wrong token). On success the answer sets the
 * HttpOnly fd_owner cookie, which holds the token for 12 hours.
 */
export type OwnerSessionRequest = {
  /** The deployment's OWNER_API_TOKEN: the shop's access code. */
  token: string;
};

/** POST, GET and DELETE /api/owner/session. */
export type OwnerSessionResponse = {
  /** Whether this browser now holds an fd_owner cookie with the right token. */
  signedIn: boolean;
  /** When the cookie expires, RFC 3339 in UTC (e.g. "2026-11-08T10:00:00Z"). Only in POST's answer. */
  expiresAt?: string;
};

// ---- Owner routes (Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie, until owner sign-in in Ring 2) ----

/** GET and PUT /api/shops/[shop]/policies: get_policies' shape, plus the owner's email. */
export type PoliciesResponse = {
  shop: Shop;
  policies: Policies;
};

/**
 * PUT /api/shops/[shop]/policies body. Send the fields to change (at least one); the others keep their
 * values. Ranges: leadTimeMin 0–10080, horizonDays 1–365, depositHorizonDays 1–365,
 * cancelWindowHours 0–720, phone 1–40 characters or null, each rule at most 1000 characters,
 * ownerEmail an address containing "@" of at most 254 characters, or null.
 */
export type UpdatePoliciesRequest = Partial<Policies>;

// ---- Owner alerts ----

/**
 * What an alert is about. `booking_confirmed`: the person approved a booking. `booking_cancelled`: the
 * agent cancelled a booking (awaiting approval or confirmed), or the person declined one. The owner's own
 * actions and lapsed holds send no alert.
 */
export type AlertKind = "booking_confirmed" | "booking_cancelled";

/**
 * How it went out. `email`: through Resend to the shop's ownerEmail (only where RESEND_API_KEY is set and
 * the shop has an ownerEmail). `log`: one JSON line in the function log, everywhere else.
 */
export type AlertChannel = "email" | "log";

/** `sent`: the email was accepted by Resend. `logged`: the log line was written. `failed`: see Alert.error. */
export type AlertStatus = "sent" | "logged" | "failed";

/** One alert to the shop owner, recorded whatever happened to it. */
export type Alert = {
  /** Increasing id. */
  id: string;
  shopSlug: string;
  /** The booking it's about (a Booking.id). */
  bookingId: string;
  kind: AlertKind;
  channel: AlertChannel;
  /** The email address it went to; null for a log line. */
  recipient: string | null;
  status: AlertStatus;
  /** Why it failed, e.g. "Resend answered HTTP 403: …". null unless status is failed. */
  error: string | null;
  /** When it was sent, RFC 3339 with the shop's offset. */
  createdAt: string;
};

/** GET /api/shops/[shop]/alerts: the shop's newest 50 alerts, newest first. */
export type AlertsResponse = {
  shop: Shop;
  alerts: Alert[];
};

/** GET and PUT /api/shops/[shop]/hours: every staff member's regular week. */
export type HoursResponse = {
  shop: Shop;
  staff: StaffWeeklyHours[];
};

/**
 * PUT /api/shops/[shop]/hours body: replaces ONE staff member's whole week. Times are "HH:mm" on the
 * 15-minute grid, open < close, and windows on the same weekday may not overlap. [] = never works.
 */
export type UpdateHoursRequest = {
  staffId: string;
  weekly: WeeklyHours[];
};

/** GET /api/shops/[shop]/blocks?from=&to= (both optional, RFC 3339). Default: 7 days ago to 1 year ahead. */
export type BlocksResponse = {
  shop: Shop;
  /** Blocks overlapping the range, sorted by start. */
  blocks: BlockedTime[];
};

/** POST /api/shops/[shop]/blocks body. start < end, at most 366 days long. Existing bookings are not touched. */
export type CreateBlockRequest = {
  staffId: string;
  /** RFC 3339 with offset. */
  start: string;
  /** RFC 3339 with offset. */
  end: string;
  /** At most 200 characters. Defaults to "". */
  reason?: string;
};

/** POST /api/shops/[shop]/blocks (201) and DELETE /api/shops/[shop]/blocks?id=<uuid> (200). */
export type BlockResponse = {
  block: BlockedTime;
};

/**
 * POST /api/shops/[shop]/services body. id: lowercase letters, digits and hyphens, 1–40 characters,
 * unique in the shop. name 1–80 characters. durationMin 5–480. priceCents 0–1,000,000.
 * depositCents 0–priceCents.
 */
export type CreateServiceRequest = Service;

/** PATCH /api/shops/[shop]/services/[id] body: at least one field. Same ranges as CreateServiceRequest. */
export type UpdateServiceRequest = Partial<Pick<Service, "name" | "durationMin" | "priceCents" | "depositCents">>;

/** POST /api/shops/[shop]/services (201) and PATCH /api/shops/[shop]/services/[id] (200). */
export type ServiceResponse = {
  service: Service;
};

/** POST /api/shops/[shop]/bookings/[id]/complete, /no-show and /cancel. */
export type OwnerBookingActionResponse = BookingTransitionResult;

/** GET /api/shops/[shop]/bookings/[id]. */
export type BookingDetailResponse = {
  booking: Booking;
  /** Oldest first. */
  events: BookingEvent[];
};

// ---- Approval page (public; the token in the path is the credential) ----
// The page at /approve/[token] reads ApprovalView, then approves (ApproveRequest, optionally with the
// person's phone number) or declines. Opening the link and tapping Approve is the consent.
// The approve and decline routes take JSON, or a plain HTML form post (303 → /approve/<token>).
// TODO(ring-1c): a code texted to the person's phone comes back once real texting ships.

/**
 * GET /api/approvals/[token]. Unknown token → 404 booking_not_found.
 * status:
 * - `pending`: the hold is on and the person can approve or decline.
 * - `awaiting_deposit`: the person approved; they must pay the deposit hold (deposit.payUrl) by deposit.payBy.
 * - `approved`: the person approved (and paid the deposit, if it needed one); the booking was confirmed.
 * - `declined`: the person declined; the booking was cancelled.
 * - `expired`: the hold lapsed, or the agent or shop cancelled the booking, before the person answered;
 *   or the person approved but the deposit wasn't paid in time, or the booking was cancelled before it was.
 */
export type ApprovalView = {
  status: "pending" | "awaiting_deposit" | "approved" | "declined" | "expired";
  shop: Shop;
  serviceName: string;
  /** Human-readable start in the shop's time zone, e.g. "Sat 14 Nov, 2:30 pm EST". */
  display: string;
  /** RFC 3339 with the shop's offset. */
  start: string;
  /** RFC 3339 with the shop's offset. */
  end: string;
  /** The service's price, in integer cents. */
  priceCents: number;
  /** The deposit the booking requires, in integer cents. 0 = none. */
  depositCents: number;
  /** Where the deposit stands; payUrl and payBy while it's awaiting payment. */
  deposit: Omit<BookingDeposit, "actionFailed">;
  /** The shop's rules to show before the person approves. */
  policies: Pick<Policies, "cancelWindowHours" | "depositRule" | "lateCancelRule" | "noShowRule">;
  /** Who asked for the booking: the agent's self-reported name. */
  agentName: string;
  /** The name the agent booked under. */
  customerName: string;
  /** The limits the agent sent with book, if any. */
  mandate?: Mandate;
  /** When the hold lapses, RFC 3339 with the shop's offset. */
  expiresAt: string;
};

/**
 * POST /api/approvals/[token]/approve body (JSON, or form fields). Optional: an empty body (or none)
 * approves too. Only while the approval is pending.
 */
export type ApproveRequest = {
  /**
   * The person's phone number, E.164, e.g. "+14015550123" (spaces, dashes, dots and parentheses are
   * ignored). Stored with the booking for the shop as Booking.customer.phone; not checked.
   */
  phone?: string;
};

/**
 * POST /api/approvals/[token]/approve response: the booking, now confirmed (customer.approved true), or
 * awaiting_deposit with booking.deposit.payUrl (Stripe Checkout) when it needs a deposit. A form post
 * answers 303 → that payUrl instead, or → /approve/<token> when the booking is confirmed.
 */
export type ApproveResponse = {
  booking: Booking;
};

/** POST /api/approvals/[token]/decline response (no body needed): the booking, now cancelled. */
export type DeclineResponse = {
  booking: Booking;
};

// ---- Environment status ----

/**
 * GET /api/status: what this deployment is and whether it's ready to be verified. Always 200 and never
 * cached. `pnpm smoke` reads it before anything else (docs/VERIFIER.md). It never contains a secret value
 * or a connection string.
 */
export type StatusResponse = {
  /** `ready` exactly when `problems` is empty. */
  status: "ready" | "not_ready";
  /** VERCEL_ENV; `development` when it isn't set (pnpm dev). */
  environment: "production" | "preview" | "development";
  /** The deployed commit: VERCEL_GIT_COMMIT_SHA, first 7 characters. null when it isn't set (pnpm dev). */
  commit: string | null;
  database: {
    /** `postgres` when DATABASE_URL is set, else `memory` (in-memory demo data; on Vercel that's a configuration error). */
    mode: "postgres" | "memory";
    /** Whether the database answered. The in-memory store always does (except on Vercel, where it isn't used). */
    reachable: boolean;
    /** The name of the shop with slug `harts`, or null (unreachable, or not seeded). */
    shopName: string | null;
    /**
     * Whether checks may write here (book, decline). Never in production. Elsewhere only when shopName ends in
     * "(preview)" (the Preview database) or the data is in memory.
     */
    writesAllowed: boolean;
    /**
     * `current`: every table and column Front Desk reads and writes exists. `outdated`: some are missing (see
     * `missing`). `unknown`: the database couldn't be inspected.
     */
    schema: "current" | "outdated" | "unknown";
    /** What's missing, e.g. "approvals.token", or a bare table name ("approvals") when the whole table is. */
    missing: string[];
  };
  /** Whether OWNER_API_TOKEN is set. Its value is never shown. */
  ownerAccess: "configured" | "missing";
  /** Whether deposits are collected (STRIPE_SECRET_KEY is set). `off` is not a problem: bookings confirm without one. */
  deposits: DepositsMode;
  /** Approval links are built on the origin of the request that creates them, like this one's. */
  approvalLinks: { origin: string };
  /**
   * How owner alerts go out: `email` when RESEND_API_KEY is set (to shops with an ownerEmail; the others are
   * still logged), else `log`. Neither is a problem.
   */
  alerts: AlertChannel;
  /** One sentence each, saying what to fix and where. Empty when ready. */
  problems: string[];
};
