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
 * - `invalid_request`: the arguments are wrong; fix them as next_action says.
 * - `not_found`: no such shop or service.
 * - `slot_taken`: someone else booked that time first; pick another start.
 * - `internal`: our fault; retry once.
 */
export type ApiErrorCode = "invalid_request" | "not_found" | "slot_taken" | "internal";

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

// ---- MCP tool shapes (structuredContent) ----

/** Input of the `list_services` tool. Takes no arguments. */
export type ListServicesInput = Record<string, never>;

/** structuredContent of a successful `list_services` call. */
export type ListServicesResult = {
  shop: Shop;
  services: Service[];
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
  /** Bookable starts, earliest first. */
  slots: Slot[];
  /** true if more slots exist in the window than were returned. */
  truncated: boolean;
};

// ---- Bookings ----

/**
 * Where a booking stands. Ring 0 only creates "confirmed" bookings; "cancelled" frees the slot.
 * Ring 1 adds "awaiting_deposit", "expired", "completed" and "no_show".
 */
export type BookingStatus = "confirmed" | "cancelled";

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
    /** Always false in Ring 0: nobody has proven who the customer is. */
    verified: false;
  };
  agent: {
    /** Best-effort label for the AI agent that booked, e.g. the MCP client's name. Unverified in Ring 0. */
    name: string;
  };
  /** Deposit the service requires, in integer cents. NOT collected in Ring 0. 0 = no deposit. */
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
};

/** structuredContent of a successful `book` call. */
export type BookResult = {
  booking: Booking;
};

// ---- HTTP routes for the UI ----

/** GET /api/shops/[shop]/services */
export type ServicesResponse = {
  shop: Shop;
  services: Service[];
};

/** GET /api/shops/[shop]/bookings. Bookings from 7 days ago to 30 days ahead, any status, sorted by start. */
export type BookingsResponse = {
  shop: Shop;
  bookings: Booking[];
};
