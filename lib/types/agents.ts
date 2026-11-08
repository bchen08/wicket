// Agent identity: which AI agent made a booking, and the agents the shop has seen.
// Agents that speak PAP 0.4 (Personal Agent Protocol, "Poppy") send a signed Poppy-Session header with their
// MCP requests; Front Desk checks it and the booking shows the agent as confirmed. Every other agent (Claude,
// ChatGPT, the web booking API, the booking page) keeps booking as before, labeled unconfirmed.
// See docs/agent-identity.md. Instants are RFC 3339 strings with the shop's offset.

import type { Shop } from "./frontdesk";

/** Who made a booking: Booking.agent. */
export type BookingAgent = {
  /**
   * The agent's name. Confirmed: the client_name from the agent's PAP client metadata. Unconfirmed: the
   * MCP client's self-reported name, the web API's bookedBy (or "web (<User-Agent>)"), or "unknown agent".
   */
  name: string;
  /** true when the agent signed its request with a PAP session that Front Desk verified. */
  confirmed: boolean;
  /** The agent's PAP client_id (a URL), only when confirmed. */
  clientId?: string;
};

/** One PAP agent Front Desk has seen, in GET /api/shops/[shop]/agents. */
export type AgentSummary = {
  /** Its PAP client_id: an HTTPS URL, or a data: URL for a demo agent that hosts nothing. */
  clientId: string;
  /** Its client_name, as of the last verified request. */
  name: string;
  /** The first and the latest verified request from it, anywhere on Front Desk. */
  firstSeen: string;
  lastSeen: string;
  /** Bookings it made at this shop, of any status (holds that lapsed or were declined included). */
  bookings: number;
  /** When it last booked at this shop, or null if it never has. */
  lastBookedAt: string | null;
};

/** GET /api/shops/[shop]/agents (owner auth). */
export type AgentsResponse = {
  shop: Shop;
  /** Every PAP agent seen, most recently seen first. */
  agents: AgentSummary[];
  /** Bookings at this shop by agents without a confirmed identity (MCP without PAP, the web API, the booking page). */
  unconfirmedBookings: number;
};

/**
 * GET /.well-known/poppy.json (public): the PAP 0.4 discovery document. Front Desk serves one shop, so the
 * document speaks for it. Only the fields Front Desk publishes; see PAP 0.4 section 3.
 */
export type PoppyDocument = {
  protocol_version: "0.4";
  organization: {
    /** The shop's name, e.g. "Hart's Barbers". */
    name: string;
    /** The host serving the document, e.g. "emergent.vercel.app". Session JWTs use `https://<domain>` as aud. */
    domain: string;
  };
  apis: {
    type: "mcp";
    /** `<origin>/api/mcp`. */
    url: string;
    description: string;
  }[];
};

/**
 * The JSON body of a refused PAP request (HTTP 400), as PAP 0.4 section 7 defines. invalid_session: the
 * Poppy-Session header failed verification; fix the cause (an expired delegation, a wrong aud) and start a
 * new Session. version_unsupported: Poppy-Version is missing or not 0.4; fetch poppy.json again.
 */
export type PapErrorBody = {
  error: "invalid_session" | "version_unsupported";
  error_description?: string;
};
