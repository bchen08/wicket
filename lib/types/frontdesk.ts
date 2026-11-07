// Shared contract for Front Desk: the MCP tools at /api/mcp and the /api/shops/* routes the UI reads.
// The UI must import these types instead of describing the shape itself.
// Money is always an integer number of cents. Instants are RFC 3339 strings with an offset.

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
 * - `idempotency_conflict`: the idempotency_key was already used with different arguments.
 * - `unauthorized`: an owner route without a valid `Authorization: Bearer` token.
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
  | "idempotency_conflict"
  | "unauthorized"
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

/** How a shop takes bookings. Set by the owner; read by agents through get_policies. */
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
};

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

/** structuredContent of a successful `get_policies` call. Also GET/PUT /api/shops/[shop]/policies. */
export type GetPoliciesResult = {
  shop: Shop;
  policies: Policies;
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
 * - `awaiting_deposit`: holds the slot until the deposit is paid. Not produced until Ring 1c.
 * - `confirmed`: the appointment is on.
 * - `cancelled`: cancelled by the agent or the owner. Frees the slot.
 * - `expired`: the deposit wasn't paid in time. Frees the slot. Not produced until Ring 1c.
 * - `completed`: the owner marked it done, after the start.
 * - `no_show`: the owner marked that the customer didn't come, after the start.
 * `awaiting_deposit` and `confirmed` hold the time; the other four are final.
 */
export type BookingStatus = "awaiting_deposit" | "confirmed" | "cancelled" | "expired" | "completed" | "no_show";

/** What the shop's policy does with the deposit when a booking changes state. */
export type DepositEffect =
  /** The booking has no deposit (depositCents is 0). */
  | "none"
  /** The customer keeps the money: any hold is dropped. */
  | "released"
  /** The shop keeps the deposit (a late cancellation or a no-show). */
  | "captured";

/** Who did something to a booking. `system` is for automatic changes (Ring 1c: deposit expiry). */
export type BookingActor = "agent" | "owner" | "system";

/** What happened to a booking. Ring 1b/1c add more. */
export type BookingEventType = "booked" | "cancelled" | "completed" | "no_show";

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
   * Specifics. `booked`: { status, agentName }. A transition: { from, to, depositEffect, depositCollected }.
   */
  data: Record<string, unknown>;
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
    /** The name the agent gave for the customer. Not verified. */
    displayName: string;
    /** Always false until Ring 1b: nobody has proven who the customer is. */
    verified: false;
  };
  agent: {
    /** Best-effort label for the AI agent that booked, e.g. the MCP client's name. Unverified. */
    name: string;
  };
  /** Deposit the service required when this booking was made, in integer cents. NOT collected until Ring 1c. 0 = none. */
  depositCents: number;
  /** When the booking was made, RFC 3339. */
  createdAt: string;
};

/** Input of the `book` tool. */
export type BookInput = {
  /** A Service.id from list_services. */
  service_id: string;
  /** A Slot.start returned by get_availability. RFC 3339 with offset. */
  start: string;
  /** Who the booking is for, 1–80 characters after trimming. */
  customer_name: string;
  /**
   * 8–128 visible ASCII characters, no spaces. A fresh UUID per intended booking. Retrying with the same key
   * and the same arguments returns the first result instead of booking twice.
   */
  idempotency_key: string;
};

/** structuredContent of a successful `book` call. */
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
  /** Like BookInput.idempotency_key: a fresh UUID per intended cancellation. */
  idempotency_key: string;
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
  /** Always false until Ring 1c: no money is held, released or captured yet. */
  depositCollected: false;
};

/** structuredContent of a successful `cancel` call. */
export type CancelResult = BookingTransitionResult;

// ---- HTTP routes for the UI ----

/** GET /api/shops/[shop]/services (public). */
export type ServicesResponse = {
  shop: Shop;
  services: Service[];
};

/** GET /api/shops/[shop]/bookings (public). Bookings from 7 days ago to 30 days ahead, any status, sorted by start. */
export type BookingsResponse = {
  shop: Shop;
  bookings: Booking[];
};

// ---- Owner routes (Authorization: Bearer <OWNER_API_TOKEN> until owner sign-in in Ring 2) ----

/** GET and PUT /api/shops/[shop]/policies. */
export type PoliciesResponse = GetPoliciesResult;

/**
 * PUT /api/shops/[shop]/policies body. Send the fields to change (at least one); the others keep their
 * values. Ranges: leadTimeMin 0–10080, horizonDays 1–365, depositHorizonDays 1–365,
 * cancelWindowHours 0–720, phone 1–40 characters or null, each rule at most 1000 characters.
 */
export type UpdatePoliciesRequest = Partial<Policies>;

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
