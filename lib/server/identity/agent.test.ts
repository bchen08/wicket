import { beforeEach, describe, expect, it } from "vitest";
import { bookAsPapAgent, createIdentity, discover, openSession, papMcpClient } from "../../../scripts/demo-pap-agent.mjs";
import type { AgentsResponse, Booking, PapErrorBody, PoppyDocument } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { agentsGet } from "../frontdesk/http";
import { createFrontDeskMcpHandler } from "../frontdesk/mcp";
import { withRequestOrigin, type FrontDeskDeps } from "../frontdesk/service";
import { memoryDeps, NOW } from "../frontdesk/test-support";
import { createMemorySigninStore } from "../oauth/memory-store";
import type { SigninStore } from "../oauth/store";
import { createAgentKeyCache, type AgentKeyCache } from "../pap/client";
import { identifyAgent, listShopAgents, poppyGet } from "./agent";
import { withCustomerSignin } from "./customer";

// Agent identity end to end: the demo PAP agent (scripts/demo-pap-agent.mjs) discovers Front Desk, opens a
// session and books through the real MCP handler, wired the way app/api/mcp/route.ts wires it. The store's
// clock and the session's clock both start at NOW (Mon 9 Nov 2026, noon in New York).

const ORIGIN = "https://frontdesk.test";
const TOKEN = "owner-token";

let current: number;
let deps: FrontDeskDeps;
let keys: AgentKeyCache;
let signin: SigninStore;
const clock: Clock = { now: () => new Date(current) };
const now = () => current;

beforeEach(() => {
  current = NOW.getTime();
  deps = memoryDeps({ clock });
  keys = createAgentKeyCache({ now });
  signin = createMemorySigninStore();
});

/** app/api/mcp/route.ts, without Next's connection(): the sign-in gate around identifyAgent and the MCP handler. */
const mcpRoute = (request: Request): Promise<Response> =>
  withCustomerSignin(
    async (req) => {
      const agent = await identifyAgent(req, () => deps, { keys, now });
      if (agent instanceof Response) return agent;
      return createFrontDeskMcpHandler(() => withRequestOrigin(deps, req), agent)(req);
    },
    () => ({ store: signin, clock }),
  )(request);

/** A fetch that serves Front Desk's routes on ORIGIN from the in-memory deps. */
const frontDesk: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  if (pathname === "/.well-known/poppy.json") return poppyGet(() => deps, request);
  if (pathname === "/api/mcp") return mcpRoute(request);
  if (pathname === "/api/shops/harts/agents") return agentsGet(() => deps, request, "harts", { getToken: () => TOKEN });
  return new Response("not found", { status: 404 });
};

/** Book a Beard trim as a PAP agent; the first open start (random 0). */
const bookAs = (identity: Awaited<ReturnType<typeof createIdentity>>) =>
  bookAsPapAgent({ baseUrl: ORIGIN, identity, fetch: frontDesk, now, random: () => 0 });

/** A booking over MCP without the Poppy-Session header, as Claude or ChatGPT book today. */
async function bookUnconfirmed(start: string, clientName = "claude-ai"): Promise<Booking> {
  const res = await frontDesk(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "book" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "book",
        arguments: { service_id: "haircut", start, customer_name: "Maya" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: clientName, version: "1.0.0" },
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  const msg = JSON.parse(await res.text()) as { result: { structuredContent: { booking: Booking }; isError?: boolean } };
  expect(msg.result.isError).toBeFalsy();
  return msg.result.structuredContent.booking;
}

const ownerAgents = async (): Promise<AgentsResponse> => {
  const res = await frontDesk(`${ORIGIN}/api/shops/harts/agents`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentsResponse;
};

describe("a PAP agent books", () => {
  it("is confirmed by name and client_id, and recorded as an agent seen", async () => {
    const identity = await createIdentity({ name: "Poppy Test Agent" });
    const { booking, mcpUrl, audience } = await bookAs(identity);

    expect(mcpUrl).toBe(`${ORIGIN}/api/mcp`);
    expect(audience).toBe(ORIGIN);
    expect(booking).toMatchObject({ serviceId: "beard-trim", status: "awaiting_approval", customer: { displayName: "Demo Customer" } });
    expect(booking.agent).toEqual({ name: "Poppy Test Agent", confirmed: true, clientId: identity.clientId });
    expect(booking.approval?.url).toMatch(new RegExp(`^${ORIGIN}/approve/`));

    // The owner's view of the booking, and its "booked" event, say the same.
    expect((await deps.store.getBooking(booking.id))?.agent).toEqual(booking.agent);
    const [booked] = await deps.store.listEvents(booking.id);
    expect(booked.data).toEqual({ status: "awaiting_approval", agentName: "Poppy Test Agent", agentClientId: identity.clientId });

    const { agents, unconfirmedBookings } = await listShopAgents(deps, "harts");
    expect(agents).toEqual([
      {
        clientId: identity.clientId,
        name: "Poppy Test Agent",
        firstSeen: "2026-11-09T12:00:00-05:00",
        lastSeen: "2026-11-09T12:00:00-05:00",
        bookings: 1,
        lastBookedAt: "2026-11-09T12:00:00-05:00",
      },
    ]);
    expect(unconfirmedBookings).toBe(0);
  });

  it("uses the verified client_name, not the name the MCP client reports", async () => {
    const identity = await createIdentity({ name: "Real Name" });
    const { mcpUrl, audience } = await discover(ORIGIN, { fetch: frontDesk });
    const session = await openSession({ identity, audience, now });
    const client = papMcpClient({ mcpUrl, session, name: "claimed-name", fetch: frontDesk });
    const slots = await client.callTool("get_availability", { service_id: "beard-trim", from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" });
    const booked = await client.callTool("book", { service_id: "beard-trim", start: slots.value.slots[0].start, customer_name: "Lee" });
    expect(booked.value.booking.agent).toMatchObject({ name: "Real Name", confirmed: true });
  });

  it("updates last seen on every verified request, keeping first seen", async () => {
    const identity = await createIdentity({ name: "Returning Agent" });
    await bookAs(identity);
    current += 3 * 3600_000;
    await bookAs(identity);
    const [agent] = (await listShopAgents(deps, "harts")).agents;
    expect(agent).toMatchObject({
      firstSeen: "2026-11-09T12:00:00-05:00",
      lastSeen: "2026-11-09T15:00:00-05:00",
      bookings: 2,
      lastBookedAt: "2026-11-09T15:00:00-05:00",
    });
  });

  it("an expired session gets PAP's invalid_session (400), and nothing is booked or recorded", async () => {
    const identity = await createIdentity();
    const { mcpUrl, audience } = await discover(ORIGIN, { fetch: frontDesk });
    // Signed two minutes before Front Desk checks it.
    const session = await openSession({ identity, audience, now: () => current - 120_000 });
    const client = papMcpClient({ mcpUrl, session, name: "x", fetch: frontDesk });
    const refused = await client.callTool("book", { service_id: "beard-trim", start: "2026-11-14T10:00:00-05:00", customer_name: "Lee" });
    expect(refused.status).toBe(400);
    expect((refused.body as PapErrorBody).error).toBe("invalid_session");
    expect((await listShopAgents(deps, "harts")).agents).toEqual([]);
    expect(await deps.store.listBookings("harts", { start: new Date(0), end: new Date(8.64e15) })).toEqual([]);
  });

  it("a session for another Company (wrong aud) gets invalid_session", async () => {
    const identity = await createIdentity();
    const session = await openSession({ identity, audience: "https://elsewhere.example", now });
    const client = papMcpClient({ mcpUrl: `${ORIGIN}/api/mcp`, session, name: "x", fetch: frontDesk });
    const refused = await client.callTool("list_services", {});
    expect(refused).toMatchObject({ status: 400, body: { error: "invalid_session", error_description: expect.stringContaining(ORIGIN) } });
  });

  it("without Poppy-Version gets version_unsupported", async () => {
    const identity = await createIdentity();
    const session = await openSession({ identity, audience: ORIGIN, now });
    const res = await mcpRoute(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: { "poppy-session": (await session.headers("POST", `${ORIGIN}/api/mcp`))["poppy-session"] },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "version_unsupported" });
  });

  it("still books if recording the agent fails (logged)", async () => {
    deps = { ...deps, store: { ...deps.store, recordAgent: async () => Promise.reject(new Error("agents table missing")) } };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const { booking } = await bookAs(await createIdentity({ name: "Unrecorded" }));
      expect(booking.agent).toMatchObject({ name: "Unrecorded", confirmed: true });
    } finally {
      console.error = original;
    }
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("a PAP agent signed in as a person (connector sign-in)", () => {
  /** A fetch to Front Desk that also carries an access token for a new customer. */
  async function signedIn(): Promise<typeof fetch> {
    const maya = await signin.upsertCustomer("harts", "+14015550123", "Maya Lopez");
    const token = "fda_test_access";
    await signin.createTokens([
      {
        token,
        kind: "access",
        shopSlug: "harts",
        clientId: "https://client.example/oauth/client.json",
        customerId: maya.id,
        scope: "bookings",
        resource: `${ORIGIN}/api/mcp`,
        expiresAt: new Date(current + 3600_000),
      },
    ]);
    return (input, init) => frontDesk(input, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });
  }
  const start = "2026-11-14T10:00:00-05:00";

  it("books as that person, with the agent confirmed, and the booking is in list_my_bookings", async () => {
    const identity = await createIdentity({ name: "Poppy Test Agent" });
    const session = await openSession({ identity, audience: ORIGIN, now });
    const client = papMcpClient({ mcpUrl: `${ORIGIN}/api/mcp`, session, name: "x", fetch: await signedIn() });

    const booked = await client.callTool("book", { service_id: "beard-trim", start });
    expect(booked.value.booking.agent).toEqual({ name: "Poppy Test Agent", confirmed: true, clientId: identity.clientId });
    expect(booked.value.booking.customer).toMatchObject({ displayName: "Maya Lopez", phone: "+14015550123" });
    expect(booked.value.texted).toBe(false);

    const mine = await client.callTool("list_my_bookings", {});
    expect(mine.value.bookings.map((b: Booking) => [b.id, b.agent.confirmed])).toEqual([[booked.value.booking.id, true]]);
  });

  it("a valid token doesn't excuse an invalid session: 400 invalid_session, nothing booked", async () => {
    const res = await (await signedIn())(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "poppy-session": "nonsense", "poppy-version": "0.4" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_session" });
  });

  it("an unknown token is refused by the sign-in gate, whatever the session says", async () => {
    const identity = await createIdentity();
    const session = await openSession({ identity, audience: ORIGIN, now });
    const res = await frontDesk(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer fda_unknown",
        ...(await session.headers("POST", `${ORIGIN}/api/mcp`)),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect((await listShopAgents(deps, "harts")).agents).toEqual([]);
  });
});

describe("an agent without PAP books", () => {
  it("goes through exactly as before: the MCP client's name, unconfirmed, nothing recorded", async () => {
    const booking = await bookUnconfirmed("2026-11-14T10:00:00-05:00");
    expect(booking.agent).toEqual({ name: "claude-ai", confirmed: false });
    expect(await identifyAgent(new Request(`${ORIGIN}/api/mcp`, { method: "POST" }), () => deps, { keys, now })).toBeNull();
    expect(await listShopAgents(deps, "harts")).toMatchObject({ agents: [], unconfirmedBookings: 1 });
  });
});

describe("GET /api/shops/[shop]/agents", () => {
  it("lists the agents seen with their booking counts and last seen, and counts unconfirmed bookings", async () => {
    const first = await createIdentity({ name: "First Agent" });
    const second = await createIdentity({ name: "Second Agent" });
    const browsing = await createIdentity({ name: "Browsing Agent" });
    await bookAs(first);
    current += 60_000;
    await bookAs(first);
    current += 60_000;
    await bookAs(second);
    current += 60_000;
    // Seen, but never booked.
    const session = await openSession({ identity: browsing, audience: ORIGIN, now });
    await papMcpClient({ mcpUrl: `${ORIGIN}/api/mcp`, session, name: "x", fetch: frontDesk }).callTool("list_services", {});
    await bookUnconfirmed("2026-11-14T10:00:00-05:00");
    await bookUnconfirmed("2026-11-14T11:00:00-05:00", "chatgpt");

    const body = await ownerAgents();
    expect(body.shop.slug).toBe("harts");
    expect(body.agents.map((a) => [a.name, a.bookings, a.lastSeen, a.lastBookedAt])).toEqual([
      ["Browsing Agent", 0, "2026-11-09T12:03:00-05:00", null],
      ["Second Agent", 1, "2026-11-09T12:02:00-05:00", "2026-11-09T12:02:00-05:00"],
      ["First Agent", 2, "2026-11-09T12:01:00-05:00", "2026-11-09T12:01:00-05:00"],
    ]);
    expect(body.agents[2]).toMatchObject({ clientId: first.clientId, firstSeen: "2026-11-09T12:00:00-05:00" });
    expect(body.unconfirmedBookings).toBe(2);
  });

  it("is an owner route: 401 without the token, and 404 for an unknown shop", async () => {
    const res = await frontDesk(`${ORIGIN}/api/shops/harts/agents`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { next_action: string } }).error.next_action).toMatch(/console\/unlock/);
    const unknown = await agentsGet(() => deps, new Request(`${ORIGIN}/api/shops/nope/agents`, { headers: { authorization: `Bearer ${TOKEN}` } }), "nope", { getToken: () => TOKEN });
    expect(unknown.status).toBe(404);
  });
});

describe("GET /.well-known/poppy.json", () => {
  it("speaks for Hart's on the request's host and points at its MCP endpoint", async () => {
    const res = await frontDesk(`${ORIGIN}/.well-known/poppy.json`);
    expect(res.status).toBe(200);
    expect((await res.json()) as PoppyDocument).toEqual({
      protocol_version: "0.4",
      organization: { name: "Hart's Barbers", domain: "frontdesk.test" },
      apis: [{ type: "mcp", url: `${ORIGIN}/api/mcp`, description: expect.stringContaining("Poppy-Session") }],
    });
  });

  it("still answers, as Front Desk, when the shop can't be read", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const res = await poppyGet(() => {
        throw new Error("DATABASE_URL is not set");
      }, new Request(`${ORIGIN}/.well-known/poppy.json`));
      expect(((await res.json()) as PoppyDocument).organization.name).toBe("Front Desk");
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
  });
});
