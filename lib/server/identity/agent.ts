import type { AgentsResponse, PoppyDocument } from "../../types/agents";
import { DEFAULT_SHOP_SLUG } from "../frontdesk/mcp";
import { requireShop, type FrontDeskDeps } from "../frontdesk/service";
import { toRfc3339 } from "../frontdesk/time";
import { createAgentKeyCache, type AgentKeyCache } from "../pap/client";
import { companyIdentifier, poppyDocument } from "../pap/discovery";
import { PapError, papErrorResponse } from "../pap/errors";
import { SESSION_HEADER, verifySession } from "../pap/session";

// Which agent is booking. Agents that speak PAP 0.4 send a signed Poppy-Session header with their MCP
// requests; when it verifies, the agent is recorded (the agents table) and its bookings show it as
// confirmed. A request without the header goes through exactly as before: its bookings carry the MCP
// client's self-reported name, unconfirmed. Protocol code is in lib/server/pap; see docs/agent-identity.md.

/** A PAP agent whose Session header verified. book() stores both on the booking (Booking.agent). */
export type ConfirmedAgent = {
  /** Its client_id: an HTTPS URL (or a data: URL for a demo agent). */
  clientId: string;
  /** client_name from its client metadata. */
  name: string;
};

/** Agents' metadata and keys, shared by every request this process serves: fetched at most every 10 minutes per agent. */
const sharedKeys = createAgentKeyCache();

export type IdentifyOptions = {
  /** For tests: where agents' metadata and keys come from. */
  keys?: AgentKeyCache;
  /** For tests: now, in milliseconds. Real time otherwise (never FRONTDESK_NOW: sessions are signed in real time). */
  now?: () => number;
};

/**
 * Who is calling: null without a Poppy-Session header (unconfirmed; nothing changes), the confirmed agent when
 * the header verifies, or the PAP error to send back as it is when it doesn't (400 invalid_session or
 * version_unsupported), so the agent knows to fix its session. A confirmed agent is recorded first (name,
 * first and last seen); if that write fails it's logged and the request still goes through.
 */
export async function identifyAgent(
  request: Request,
  getDeps: () => FrontDeskDeps,
  options: IdentifyOptions = {},
): Promise<ConfirmedAgent | null | Response> {
  if (!request.headers.has(SESSION_HEADER)) return null;
  let agent: ConfirmedAgent;
  try {
    const session = await verifySession(request.headers, {
      audience: companyIdentifier(request.url),
      keys: options.keys ?? sharedKeys,
      now: (options.now ?? Date.now)(),
    });
    agent = { clientId: session.clientId, name: session.clientName };
  } catch (err) {
    if (err instanceof PapError) return papErrorResponse(err);
    throw err;
  }
  try {
    await getDeps().store.recordAgent(agent);
  } catch (err) {
    console.error("[identity] couldn't record the agent", agent.clientId.slice(0, 120), err);
  }
  return agent;
}

/**
 * The PAP agents Front Desk has seen, most recently seen first, each with its bookings at the shop (any status)
 * and when it last booked there; and how many of the shop's bookings came from unconfirmed agents. An owner
 * route: the HTTP layer checks owner auth first.
 * TODO(ring-2): agents are recorded for Front Desk as a whole; scope them to a shop once agents can pick one.
 */
export async function listShopAgents(deps: FrontDeskDeps, shopSlug: string): Promise<AgentsResponse> {
  const shop = await requireShop(deps, shopSlug);
  const activity = await deps.store.listAgents(shopSlug);
  const at = (d: Date) => toRfc3339(d, shop.timezone);
  return {
    shop,
    agents: activity.agents.map((a) => ({
      clientId: a.clientId,
      name: a.name,
      firstSeen: at(a.firstSeen),
      lastSeen: at(a.lastSeen),
      bookings: a.bookings,
      lastBookedAt: a.lastBookedAt ? at(a.lastBookedAt) : null,
    })),
    unconfirmedBookings: activity.unconfirmedBookings,
  };
}

/**
 * GET /.well-known/poppy.json (rewritten to /api/well-known/poppy) → PoppyDocument for this request's origin,
 * speaking for the one shop Front Desk serves. If the shop can't be read, the document still answers, named
 * "Front Desk", so discovery never depends on the database.
 */
export async function poppyGet(getDeps: () => FrontDeskDeps, request: Request): Promise<Response> {
  let name = "Front Desk";
  try {
    name = (await requireShop(getDeps(), DEFAULT_SHOP_SLUG)).name;
  } catch (err) {
    console.error("[identity] poppy.json without the shop's name", err);
  }
  const body: PoppyDocument = poppyDocument(new URL(request.url).origin, name);
  return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
}
