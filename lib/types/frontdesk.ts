// Shared contract for Front Desk: the MCP tools at /api/mcp (and, later, the UI).
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

export type ApiErrorCode = "invalid_request" | "not_found" | "internal";

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
