// The web booking API: plain HTTP routes for agents that use web requests or a browser instead of MCP,
// and the backend of the web booking page. Same engine and approval link as the MCP tools. Re-exported
// from lib/types/frontdesk.ts. See docs/web-booking.md.

import type { AgentPolicies, Booking, Mandate, Service, Shop, Slot } from "./frontdesk";

/** One day of open starts, in the shop's time zone. */
export type AvailabilityDay = {
  /** The local date in the shop's time zone, YYYY-MM-DD, e.g. "2026-11-14". */
  date: string;
  /** The date for people, e.g. "Sat 14 Nov". */
  display: string;
  /**
   * Open starts that day, earliest first: the same Slots the MCP get_availability tool returns for
   * [that day's local midnight, the next local midnight). Empty when the shop is closed, fully booked,
   * the day is outside how far ahead the service can be booked, or bookings are paused.
   */
  slots: Slot[];
};

/**
 * GET /api/shops/[shop]/availability?service=<id>&from=<YYYY-MM-DD>&days=<1..14> (public).
 * `from` defaults to today in the shop's time zone, `days` to 7.
 */
export type WebAvailabilityResponse = {
  shop: Shop;
  service: Service;
  /** The first day, YYYY-MM-DD in the shop's time zone. */
  from: string;
  /** The day after the last one (exclusive), YYYY-MM-DD in the shop's time zone. */
  to: string;
  /** One entry per day from `from`, in order, including days with no open starts. */
  days: AvailabilityDay[];
  /** true when the owner paused bookings: every day is empty. Tell the person to call `phone`. */
  paused: boolean;
  /** The shop's phone number, or null if it has none. */
  phone: string | null;
};

/**
 * POST /api/shops/[shop]/book body, as JSON or plain HTML form fields (application/x-www-form-urlencoded
 * or multipart/form-data). Unknown fields are ignored.
 */
export type WebBookRequest = {
  /** A Service.id, e.g. "haircut". */
  service: string;
  /** A Slot.start from the availability route, copied exactly. RFC 3339 with offset. */
  start: string;
  /** The name the booking is under, 1–80 characters after trimming. */
  name: string;
  /**
   * The booking agent's name, shown to the person and the shop. Optional: without it the booking shows
   * "web" plus the first 60 characters of the request's User-Agent.
   */
  bookedBy?: string;
  /** The person's limits, as in MCP book. JSON only; optional. The server refuses a booking outside them. */
  mandate?: Mandate;
  /**
   * The person's mobile number, E.164, e.g. "+14015550123" (spaces, dashes, dots and parentheses are ignored).
   * Optional, as in MCP book (customer_phone): stored on the booking, and where texting is on, the approval
   * link is texted to it (WebBookResponse.texted).
   */
  phone?: string;
};

/**
 * POST /api/shops/[shop]/book, JSON → 201. A form post gets 303 → booking.approval.url instead (the
 * approval page); a refused form post gets 303 back to the Referer with ?error=<code>&message=<text>.
 */
export type WebBookResponse = {
  /** The hold: status awaiting_approval, with approval.url (send it to the person) and approval.expiresAt. */
  booking: Booking;
  /**
   * GET it to see what the person did: an ApprovalView whose status is pending, approved, declined or
   * expired. It's `<origin>/api/approvals/<token>`, the approval link's own API.
   */
  statusUrl: string;
  /**
   * true when Front Desk texted the approval link to `phone`: don't send it again. false when no phone was
   * given, texting is off, or the text didn't go through: send booking.approval.url yourself.
   */
  texted: boolean;
  /** What the agent should do now, in plain words: send the link (unless it was texted), then check statusUrl. */
  next_action: string;
};

/** A service on the booking page, with its open starts. */
export type BookingPageService = Service & {
  /** The next 7 days of open starts, today first, one entry per day (empty days included). */
  days: AvailabilityDay[];
};

/** GET /api/shops/[shop]/booking-page (public): everything the web booking page needs, in one call. */
export type BookingPageResponse = {
  shop: Shop;
  /** Every service, in the shop's order, each with the next 7 days of open starts. */
  services: BookingPageService[];
  /**
   * The shop's rules, as agents get them from get_policies: everything but the owner's email. `paused: true`
   * means no starts are offered; show `phone`.
   */
  policies: AgentPolicies;
  /** The rules in plain language for the person, one sentence per line (split on "\n"). */
  policiesText: string;
  /** Today, YYYY-MM-DD in the shop's time zone: the first day in every service's `days`. */
  from: string;
  /** Where the page's form posts: `<origin>/api/shops/<shop>/book` (fields: service, start, name, bookedBy, phone). */
  bookUrl: string;
};

/** GET /.well-known/front-desk.json (public): where agents find Front Desk. */
export type FrontDeskDiscovery = {
  name: "Front Desk";
  description: string;
  /** The shop these URLs serve, e.g. "harts". One shop for now. */
  shop: string;
  /** The MCP endpoint (Streamable HTTP, no auth): `<origin>/api/mcp`. Agents with MCP should use it. */
  mcp: string;
  /** The web API base for the shop: `<origin>/api/shops/<shop>`. */
  webApi: string;
  /** Plain-text instructions for agents: `<origin>/api/shops/<shop>/agents.md`. */
  agentsMd: string;
  /**
   * The PAP 0.4 discovery document: `<origin>/.well-known/poppy.json` (PoppyDocument in lib/types/agents.ts).
   * Agents that speak PAP sign their MCP requests so bookings show them as confirmed.
   */
  poppy: string;
  /** The web API's routes, as full URLs. */
  endpoints: {
    /** GET ?service=<id>&from=<YYYY-MM-DD>&days=<1..14> → WebAvailabilityResponse. */
    availability: string;
    /** POST WebBookRequest → WebBookResponse. */
    book: string;
    /** GET → BookingPageResponse. */
    bookingPage: string;
  };
};
