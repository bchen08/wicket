import { beforeEach, describe, expect, it } from "vitest";
import type { Booking, BookResult, CancelResult, GetBookingResult } from "../../types/frontdesk";
import type { ListMyBookingsResult } from "../../types/oauth";
import { createFrontDeskMcpHandler } from "../frontdesk/mcp";
import type { FrontDeskDeps } from "../frontdesk/service";
import { EXAMPLE_BOOKINGS, memoryDeps, NOW } from "../frontdesk/test-support";
import { createMemorySigninStore } from "../oauth/memory-store";
import type { Customer, SigninStore } from "../oauth/store";
import { bookArgsFor, parseCustomerName, parseMobile, withCustomerSignin } from "./customer";

// The gate on /api/mcp, end to end through the real MCP handler wrapped the way app/api/mcp/route.ts wraps
// it: anonymous calls are served as before; list_my_bookings and a book without customer_name ask for
// sign-in with a 401; a valid token makes the tools act for its customer. "Now" is Mon 9 Nov 2026, noon in
// New York; Saturday 14 Nov is open, with the two example bookings at 10:00 and 15:00.

const ORIGIN = "http://localhost:3000";
const SLOT = "2026-11-14T14:30:00-05:00";
const LATER_SLOT = "2026-11-14T16:00:00-05:00";
const HOUR_MS = 60 * 60 * 1000;

let deps: FrontDeskDeps;
let signin: SigninStore;
let maya: Customer;
let lee: Customer;
let gated: (request: Request) => Promise<Response>;
let bare: (request: Request) => Promise<Response>;

/** Store an access token for `customer`, expiring at `expiresAt`. */
async function tokenFor(customer: Customer, expiresAt = new Date(NOW.getTime() + HOUR_MS)): Promise<string> {
  const token = `fda_test_${customer.id}_${expiresAt.getTime()}`;
  await signin.createTokens([
    {
      token,
      kind: "access",
      shopSlug: "harts",
      clientId: "https://client.example/oauth/client.json",
      customerId: customer.id,
      scope: "bookings",
      resource: `${ORIGIN}/api/mcp`,
      expiresAt,
    },
  ]);
  return token;
}

beforeEach(async () => {
  deps = memoryDeps({ initialBookings: EXAMPLE_BOOKINGS });
  signin = createMemorySigninStore();
  maya = await signin.upsertCustomer("harts", "+14015550123", "Maya Lopez");
  lee = await signin.upsertCustomer("harts", "+14015550199", "Lee Park");
  bare = createFrontDeskMcpHandler(() => deps);
  gated = withCustomerSignin(bare, () => ({ store: signin, clock: deps.clock }));
});

let nextId = 1;
function mcpRequest(method: string, params: Record<string, unknown>, token?: string): Request {
  return new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean };

async function resultOf<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const body = await res.text();
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
  const msg = JSON.parse(json) as { result?: T; error?: unknown };
  if (msg.error) throw new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`);
  return msg.result as T;
}

const call = (handler: typeof gated, name: string, args: Record<string, unknown> = {}, token?: string) =>
  handler(mcpRequest("tools/call", { name, arguments: args }, token));

const callTool = async (name: string, args: Record<string, unknown> = {}, token?: string) =>
  resultOf<ToolResult>(await call(gated, name, args, token));

/** A structured result with its volatile parts (ids, links, creation time) blanked, to compare two runs. */
function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
      .replace(/\/approve\/[A-Za-z0-9_-]{43}/g, "/approve/<token>"),
  );
}

/** Expect the sign-in challenge: 401 with a Bearer WWW-Authenticate pointing at the metadata. */
async function expectChallenge(res: Response, description: RegExp) {
  expect(res.status).toBe(401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain('error="invalid_token"');
  expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
  expect(challenge).toContain('scope="bookings"');
  expect(challenge).toMatch(description);
}

describe("anonymous calls are served as before", () => {
  it("initialize, tools/list and every existing tool answer the same through the gate as without it", async () => {
    const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
    expect(await resultOf(await gated(mcpRequest("initialize", init)))).toEqual(await resultOf(await bare(mcpRequest("initialize", init))));
    expect(await resultOf(await gated(mcpRequest("tools/list", {})))).toEqual(await resultOf(await bare(mcpRequest("tools/list", {}))));

    const sat = { service_id: "haircut", from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" };
    for (const [name, args] of [
      ["list_services", {}],
      ["get_policies", {}],
      ["get_availability", sat],
    ] as const) {
      expect(await resultOf(await call(gated, name, args))).toEqual(await resultOf(await call(bare, name, args)));
    }

    // book with a name: the same hold and text as before (each run on a fresh store).
    const viaGate = await callTool("book", { service_id: "haircut", start: SLOT, customer_name: "Jo" });
    deps = memoryDeps({ initialBookings: EXAMPLE_BOOKINGS });
    const direct = await resultOf<ToolResult>(await call(bare, "book", { service_id: "haircut", start: SLOT, customer_name: "Jo" }));
    expect(stable(viaGate)).toEqual(stable(direct));
    expect((viaGate.structuredContent as BookResult).booking.customer).toEqual({ displayName: "Jo", approved: false });

    // get_booking and cancel by id through the gate, as before (on the store that holds `direct`'s booking).
    const booked = (direct.structuredContent as BookResult).booking;
    const read = await callTool("get_booking", { booking_id: booked.id });
    expect((read.structuredContent as GetBookingResult).booking.id).toBe(booked.id);
    const cancelled = await callTool("cancel", { booking_id: booked.id });
    expect((cancelled.structuredContent as CancelResult).booking.status).toBe("cancelled");
  });

  it("an anonymous booking belongs to nobody: no signed-in customer lists it", async () => {
    await callTool("book", { service_id: "haircut", start: SLOT, customer_name: "Jo" });
    const mine = await callTool("list_my_bookings", {}, await tokenFor(maya));
    expect((mine.structuredContent as ListMyBookingsResult).bookings).toEqual([]);
  });

  it("without the gate (the bare handler), a book without customer_name is still the invalid_request it was", async () => {
    const result = await resultOf<ToolResult>(await call(bare, "book", { service_id: "haircut", start: SLOT }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatchObject({ code: "invalid_request", details: { field: "customer_name" } });
  });
});

describe("calls that need sign-in get the 401 challenge", () => {
  it("list_my_bookings without a token", async () => {
    await expectChallenge(await call(gated, "list_my_bookings"), /see your bookings/);
  });

  it("book without customer_name (missing, null or blank), so the client signs the person in and retries", async () => {
    for (const customer_name of [undefined, null, "   "]) {
      const args = { service_id: "haircut", start: SLOT, ...(customer_name === undefined ? {} : { customer_name }) };
      await expectChallenge(await call(gated, "book", args), /book as yourself/);
    }
    // Nothing was held.
    expect(await deps.store.listBookings("harts", { start: new Date("2026-11-14T05:00:00Z"), end: new Date("2026-11-15T05:00:00Z") })).toHaveLength(2);
  });

  it("an unknown or expired token, on any call", async () => {
    const unknown = await call(gated, "list_services", {}, "fda_unknown");
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const expired = await tokenFor(maya, new Date(NOW.getTime()));
    const res = await call(gated, "list_services", {}, expired);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/expired/);
  });
});

describe("with a valid token", () => {
  it("book fills the customer's name and phone, and the booking is theirs", async () => {
    const token = await tokenFor(maya);
    const result = await callTool("book", { service_id: "haircut", start: SLOT }, token);
    expect(result.isError).toBeUndefined();
    const booking = (result.structuredContent as BookResult).booking;
    expect(booking.status).toBe("awaiting_approval");
    expect(booking.customer).toEqual({ displayName: "Maya Lopez", approved: false, phone: "+14015550123" });
    expect(result.content[0].text).toContain("for Maya Lopez");

    const mine = (await callTool("list_my_bookings", {}, token)).structuredContent as ListMyBookingsResult;
    expect(mine.customer).toEqual({ name: "Maya Lopez", phone: "+14015550123" });
    expect(mine.bookings.map((b) => b.id)).toEqual([booking.id]);
    expect(mine.bookings[0].approval?.url).toBe(booking.approval?.url);
  });

  it("book keeps a name the agent sends (booking for someone else), still under the signed-in customer", async () => {
    const token = await tokenFor(maya);
    const booking = ((await callTool("book", { service_id: "haircut", start: SLOT, customer_name: "Leo Lopez" }, token)).structuredContent as BookResult).booking;
    expect(booking.customer.displayName).toBe("Leo Lopez");
    expect(booking.customer.phone).toBe("+14015550123");
    const mine = (await callTool("list_my_bookings", {}, token)).structuredContent as ListMyBookingsResult;
    expect(mine.bookings.map((b) => b.id)).toEqual([booking.id]);
  });

  it("list_my_bookings returns only that customer's bookings, sorted by start, with statuses kept current", async () => {
    const mayaToken = await tokenFor(maya);
    const leeToken = await tokenFor(lee);
    const later = ((await callTool("book", { service_id: "haircut", start: LATER_SLOT }, mayaToken)).structuredContent as BookResult).booking;
    const earlier = ((await callTool("book", { service_id: "haircut", start: SLOT }, mayaToken)).structuredContent as BookResult).booking;
    const lees = ((await callTool("book", { service_id: "beard-trim", start: "2026-11-14T11:00:00-05:00" }, leeToken)).structuredContent as BookResult).booking;
    await callTool("book", { service_id: "haircut", start: "2026-11-14T12:00:00-05:00", customer_name: "Anonymous" });

    const mine = (await callTool("list_my_bookings", {}, mayaToken)).structuredContent as ListMyBookingsResult;
    expect(mine.bookings.map((b: Booking) => b.id)).toEqual([earlier.id, later.id]);
    expect(mine.truncated).toBe(false);
    const theirs = (await callTool("list_my_bookings", {}, leeToken)).structuredContent as ListMyBookingsResult;
    expect(theirs.bookings.map((b) => b.id)).toEqual([lees.id]);
    expect(theirs.customer.name).toBe("Lee Park");
  });

  it("get_booking and cancel work on the ids list_my_bookings gives: cancel the Saturday one", async () => {
    const token = await tokenFor(maya);
    await callTool("book", { service_id: "haircut", start: SLOT }, token);
    const listed = (await callTool("list_my_bookings", {}, token)) as ToolResult;
    expect(listed.content[0].text).toMatch(/Maya Lopez \(\+14015550123\) is signed in/);
    const saturday = (listed.structuredContent as ListMyBookingsResult).bookings.find((b) => b.display.startsWith("Sat 14 Nov"))!;
    expect(listed.content[0].text).toContain(`Booking id: ${saturday.id}`);

    const read = await callTool("get_booking", { booking_id: saturday.id }, token);
    expect((read.structuredContent as GetBookingResult).booking.customer.displayName).toBe("Maya Lopez");
    const cancelled = await callTool("cancel", { booking_id: saturday.id }, token);
    expect((cancelled.structuredContent as CancelResult).booking.status).toBe("cancelled");

    const after = (await callTool("list_my_bookings", {}, token)).structuredContent as ListMyBookingsResult;
    expect(after.bookings.map((b) => [b.id, b.status])).toEqual([[saturday.id, "cancelled"]]);
  });

  it("list_my_bookings shows a hold that ran out as expired", async () => {
    const token = await tokenFor(maya, new Date(NOW.getTime() + 2 * HOUR_MS));
    await callTool("book", { service_id: "haircut", start: SLOT }, token);
    deps = { ...deps, clock: { now: () => new Date(NOW.getTime() + HOUR_MS) } };
    const mine = (await callTool("list_my_bookings", {}, token)).structuredContent as ListMyBookingsResult;
    expect(mine.bookings.map((b) => b.status)).toEqual(["expired"]);
  });
});

describe("helpers", () => {
  it("parseMobile takes E.164 anywhere and 10- or 11-digit US numbers", () => {
    expect(parseMobile("+1 401 555 0123")).toBe("+14015550123");
    expect(parseMobile("+44 7700 900123")).toBe("+447700900123");
    expect(parseMobile("(401) 555-0123")).toBe("+14015550123");
    expect(parseMobile("1-401-555-0123")).toBe("+14015550123");
    for (const bad of ["", "555-0123", "0401 555 0123", "+0123456789", "abc", 4015550123]) expect(parseMobile(bad)).toBeNull();
  });

  it("parseCustomerName trims and allows 1–80 characters without control characters", () => {
    expect(parseCustomerName("  Maya  ")).toBe("Maya");
    for (const bad of ["", "   ", "x".repeat(81), "Ma\u0000ya", "Ma\nya", null]) expect(parseCustomerName(bad)).toBeNull();
  });

  it("bookArgsFor fills customer_name only when signed in and missing", () => {
    const args = { service_id: "haircut", start: SLOT };
    expect(bookArgsFor(args, maya)).toEqual({ ...args, customer_name: "Maya Lopez" });
    expect(bookArgsFor({ ...args, customer_name: "" }, maya)).toEqual({ ...args, customer_name: "Maya Lopez" });
    expect(bookArgsFor({ ...args, customer_name: "Leo" }, maya)).toEqual({ ...args, customer_name: "Leo" });
    expect(bookArgsFor(args, null)).toBe(args);
  });
});
