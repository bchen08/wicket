import { beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  BookResult,
  CancelResult,
  GetAvailabilityResult,
  GetBookingResult,
  GetPoliciesResult,
  ListServicesResult,
  Slot,
} from "../../types/frontdesk";
import { agentNameFrom, createFrontDeskMcpHandler } from "./mcp";
import { SEED } from "./memory-store";
import type { FrontDeskDeps } from "./service";
import { EXAMPLE_BOOKINGS, memoryDeps, withCatalog } from "./test-support";

// End to end through the real MCP handler (the same one /api/mcp mounts), speaking
// stateless Streamable HTTP JSON-RPC. "Now" is Mon 9 Nov 2026, noon in New York, so the coming
// Saturday is 14 Nov (5 days ahead). Each test gets a fresh in-memory store holding the two example
// bookings on that Saturday (10:00–10:45 and 15:00–15:30) and Hart's seeded rules.
let deps: FrontDeskDeps;
beforeEach(() => {
  deps = memoryDeps({ initialBookings: EXAMPLE_BOOKINGS });
});
// Deps are resolved per tool call, the same way the route passes getFrontDeskDeps.
const handler = createFrontDeskMcpHandler(() => deps);

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

type ListedTool = {
  name: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: { required?: string[]; properties?: Record<string, Record<string, unknown>> };
  outputSchema?: unknown;
};

let nextId = 1;
async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await handler(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  // The response is either plain JSON or a single SSE "message" event.
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

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  rpc<ToolResult>("tools/call", { name, arguments: args });

const listTools = async () => (await rpc<{ tools: ListedTool[] }>("tools/list")).tools;

/** The ApiError envelope a failed tool call carries in its text. */
function envelopeOf(result: ToolResult): ApiError["error"] {
  expect(result.isError).toBe(true);
  // Not in structuredContent: clients validate that against outputSchema even on errors.
  expect(result.structuredContent).toBeUndefined();
  return (JSON.parse(result.content[0].text) as ApiError).error;
}

const key = () => crypto.randomUUID();
const SAT = { from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" };
const SLOT = "2026-11-14T14:30:00-05:00";
const bookArgs = (extra: Record<string, unknown> = {}) => ({
  service_id: "haircut",
  start: SLOT,
  customer_name: "Maya",
  idempotency_key: key(),
  ...extra,
});

describe("MCP /api/mcp", () => {
  it("lists six tools: four read-only reads, book (idempotent, not destructive), cancel (destructive, idempotent)", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "book",
      "cancel",
      "get_availability",
      "get_booking",
      "get_policies",
      "list_services",
    ]);
    for (const name of ["list_services", "get_policies", "get_availability", "get_booking"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    expect(tools.find((t) => t.name === "book")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.find((t) => t.name === "cancel")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });

  it("documents RFC 3339 inputs and the window limit on get_availability", async () => {
    const avail = (await listTools()).find((t) => t.name === "get_availability")!;
    expect(avail.description).toMatch(/14 days/);
    expect(avail.description).toMatch(/America\/New_York/);
    expect(avail.description).toMatch(/paused/);
    expect(avail.inputSchema.properties?.from?.description).toMatch(/RFC 3339/);
    expect(avail.inputSchema.properties?.to?.description).toMatch(/RFC 3339/);
    expect(avail.inputSchema.properties?.from?.format).toBe("date-time");
  });

  it("advertises idempotency_key (required for book and cancel) and booking_id in the input schemas", async () => {
    const tools = await listTools();
    const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema;
    expect([...(schema("book").required ?? [])].sort()).toEqual(["customer_name", "idempotency_key", "service_id", "start"]);
    expect([...(schema("cancel").required ?? [])].sort()).toEqual(["booking_id", "idempotency_key"]);
    expect(schema("get_booking").required).toEqual(["booking_id"]);
    for (const name of ["book", "cancel"]) {
      expect(schema(name).properties?.idempotency_key).toMatchObject({ type: "string", minLength: 8, maxLength: 128 });
      expect(String(schema(name).properties?.idempotency_key.description)).toMatch(/fresh UUID/);
    }
    for (const name of ["get_booking", "cancel"]) {
      expect(schema(name).properties?.booking_id).toMatchObject({ type: "string" });
    }
  });

  it("tells agents the flow, the rules and the open-access caveat in the descriptions", async () => {
    const tools = await listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description;
    for (const name of ["get_booking", "cancel"]) {
      expect(description(name)).toMatch(/anyone holding a booking id can/);
      expect(description(name)).toMatch(/booking_not_found/);
    }
    expect(description("cancel")).toMatch(/cancelWindowHours/);
    expect(description("cancel")).toMatch(/not_cancellable/);
    expect(description("cancel")).toMatch(/depositCollected/);
    for (const code of ["slot_taken", "too_soon", "too_far", "outside_hours", "paused", "idempotency_conflict"]) {
      expect(description("book")).toContain(code);
    }
  });

  it("list_services shows dollars in text and cents in structuredContent", async () => {
    const result = await callTool("list_services");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("$35.00");
    expect(result.content[0].text).toContain("America/New_York");
    const data = result.structuredContent as ListServicesResult;
    expect(data.shop).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
    expect(data.services.find((s) => s.id === "haircut")).toMatchObject({ priceCents: 3500, depositCents: 1000 });
    expect(data.services.find((s) => s.id === "beard-trim")).toMatchObject({ depositCents: 0 });
  });

  it("get_policies returns Hart's rules, and reads them in plain language", async () => {
    const result = await callTool("get_policies");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
      policies: SEED.policies.harts,
    } satisfies GetPoliciesResult);
    const text = result.content[0].text;
    expect(text).toContain("Bookings are open.");
    expect(text).toContain("Book at least 2 hours ahead.");
    expect(text).toContain("up to 30 days ahead");
    expect(text).toContain("up to 6 days ahead");
    expect(text).toContain("at least 24 hours before the start releases the deposit");
    expect(text).toContain("+1 212-555-0142");
    expect(text).toContain(`Deposit: ${SEED.policies.harts.depositRule}`);
    expect(text).toContain(`Late cancellation: ${SEED.policies.harts.lateCancelRule}`);
    expect(text).toContain(`No-show: ${SEED.policies.harts.noShowRule}`);
  });

  it("get_availability returns Saturday slots that skip lunch and the example bookings", async () => {
    const result = await callTool("get_availability", { service_id: "haircut", ...SAT, limit: 50 });
    expect(result.isError).toBeFalsy();
    const { slots, truncated } = result.structuredContent as GetAvailabilityResult;
    const times = slots.map((s) => s.start.slice(11, 16));
    expect(times).not.toContain("10:00"); // booking
    expect(times).not.toContain("12:00"); // lunch
    expect(times).not.toContain("15:00"); // booking
    expect(times).toContain("10:45");
    expect(slots).toHaveLength(21);
    expect(truncated).toBe(false);
  });

  it("returns the ApiError envelope as a tool error for an unknown service", async () => {
    const error = envelopeOf(await callTool("get_availability", { service_id: "perm", ...SAT }));
    expect(error.code).toBe("not_found");
    expect(error.next_action).toMatch(/list_services/);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a 15-day window", { service_id: "haircut", from: SAT.from, to: "2026-11-29T00:00:00-05:00" }],
    ["from after to", { service_id: "haircut", from: SAT.to, to: SAT.from }],
    ["a date with no offset", { service_id: "haircut", from: "2026-11-14", to: SAT.to }],
    ["an out-of-range offset", { service_id: "haircut", from: "2026-11-14T09:00:00+99:99", to: SAT.to }],
    ["a limit over 50", { service_id: "haircut", ...SAT, limit: 99 }],
    ["a limit that is a string", { service_id: "haircut", ...SAT, limit: "5" }],
    ["a missing service_id", { ...SAT }],
    ["a numeric service_id", { service_id: 5, ...SAT }],
    ["a missing to", { service_id: "haircut", from: SAT.from }],
    ["no arguments at all", {}],
  ])("returns the invalid_request envelope for %s", async (_label, args) => {
    const error = envelopeOf(await callTool("get_availability", args));
    expect(error.code).toBe("invalid_request");
    expect(error.next_action.length).toBeGreaterThan(0);
  });

  it("treats limit: null as omitted (default 20)", async () => {
    const result = await callTool("get_availability", { service_id: "haircut", ...SAT, limit: null });
    expect(result.isError).toBeFalsy();
    const { slots, truncated } = result.structuredContent as GetAvailabilityResult;
    expect(slots).toHaveLength(20);
    expect(truncated).toBe(true);
  });

  it("advertises types, formats, limits and required fields in the get_availability input schema", async () => {
    const schema = (await listTools()).find((t) => t.name === "get_availability")!.inputSchema;
    expect([...(schema.required ?? [])].sort()).toEqual(["from", "service_id", "to"]);
    expect(schema.properties?.service_id).toMatchObject({ type: "string" });
    expect(schema.properties?.from).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties?.to).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
  });

  it("while paused: get_availability is empty and says to call the shop; get_policies says PAUSED", async () => {
    deps = memoryDeps({ policies: { paused: true } });
    const avail = await callTool("get_availability", { service_id: "haircut", ...SAT });
    expect(avail.isError).toBeFalsy();
    expect(avail.structuredContent).toEqual({ slots: [], truncated: false });
    expect(avail.content[0].text).toBe(
      "Hart's Barbers isn't taking bookings right now, so there are no open times. " +
        "Tell the person to call the shop at +1 212-555-0142.",
    );
    expect((await callTool("get_policies")).content[0].text).toContain("Bookings are PAUSED");
  });
});

describe("MCP book tool", () => {
  it("is advertised with idempotency and the rules in its description, and actionable inputs", async () => {
    const tool = (await listTools()).find((t) => t.name === "book")!;
    expect(tool.description).toMatch(/immediately/);
    expect(tool.description).toMatch(/No deposit is collected/);
    expect(tool.description).toMatch(/not verified/);
    expect(tool.description).toMatch(/send a fresh UUID per booking/);
    expect(tool.description).toMatch(/returns the same booking instead of booking twice/);
    expect(tool.inputSchema.properties?.start).toMatchObject({ type: "string", format: "date-time" });
    expect(String(tool.inputSchema.properties?.start.description)).toMatch(/returned by get_availability/);
    expect(tool.inputSchema.properties?.customer_name).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
  });

  it("books a slot, returns BookResult and a summary, and the slot disappears", async () => {
    const result = await callTool("book", bookArgs());
    expect(result.isError).toBeFalsy();
    const { booking } = result.structuredContent as BookResult;
    expect(booking).toMatchObject({
      shopSlug: "harts",
      serviceId: "haircut",
      serviceName: "Haircut",
      staffId: "dana",
      start: SLOT,
      end: "2026-11-14T15:00:00-05:00",
      display: "Sat 14 Nov, 2:30 pm EST",
      status: "confirmed",
      customer: { displayName: "Maya", verified: false },
      agent: { name: "unknown agent" }, // 2025-era requests carry no clientInfo
      depositCents: 1000,
      createdAt: "2026-11-09T12:00:00-05:00",
    });
    expect(result.content[0].text).toContain(
      "Booked Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. A $10 deposit will be required once deposits are enabled",
    );
    expect(result.content[0].text).toContain(booking.id);
    expect(result.content[0].text).not.toContain("replayed");

    const after = await callTool("get_availability", {
      service_id: "haircut",
      from: "2026-11-14T14:00:00-05:00",
      to: "2026-11-14T16:00:00-05:00",
    });
    const starts = (after.structuredContent as GetAvailabilityResult).slots.map((s) => s.start.slice(11, 16));
    expect(starts).not.toContain("14:30");
  });

  it("refuses the same slot twice with slot_taken and up to 3 nearby alternatives", async () => {
    expect((await callTool("book", bookArgs())).isError).toBeFalsy();
    const error = envelopeOf(await callTool("book", bookArgs({ customer_name: "Jo" })));
    expect(error.code).toBe("slot_taken");
    expect(error.next_action).toMatch(/^Someone just took that time\. Call get_availability again and choose another start\./);
    expect(error.next_action).toMatch(/details\.alternatives/);
    // 14:30–15:00 is now booked and 15:00–15:30 already was: the nearest free haircut starts are before.
    const alternatives = (error.details as { alternatives: Slot[] }).alternatives;
    expect(alternatives.map((s) => s.start.slice(11, 16))).toEqual(["13:30", "13:45", "14:00"]);
  });

  it("returns slot_taken through the envelope when the database refuses an overlap", async () => {
    expect((await callTool("book", bookArgs())).isError).toBeFalsy();
    // Simulate a race: this call's availability check misses the booking above; the store has it.
    let reads = 0;
    deps = withCatalog(deps, (catalog) => ({
      getBusyIntervals: async (slug, range) => (reads++ === 0 ? [] : catalog.getBusyIntervals(slug, range)),
    }));
    const error = envelopeOf(await callTool("book", bookArgs({ customer_name: "Jo" })));
    expect(error.code).toBe("slot_taken");
    expect(error.next_action).toMatch(/^Someone just took that time\. Call get_availability again/);
    expect((error.details as { alternatives: Slot[] }).alternatives.length).toBeGreaterThan(0);
  });

  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ["a past start", { start: "2026-11-09T13:00:00-05:00" }, "too_soon", { earliest: "2026-11-09T14:00:00-05:00" }],
    ["a haircut beyond the 6-day deposit horizon", { start: "2026-11-17T10:00:00-05:00" }, "too_far", { latest: "2026-11-15T12:00:00-05:00" }],
    ["a start during lunch", { start: "2026-11-14T12:00:00-05:00" }, "outside_hours", { field: "start" }],
  ])("returns the envelope for %s: %s", async (_label, extra, code, details) => {
    const error = envelopeOf(await callTool("book", bookArgs(extra)));
    expect(error.code).toBe(code);
    expect(error.details).toMatchObject(details);
    expect(error.next_action.length).toBeGreaterThan(0);
  });

  it("returns the paused envelope with the shop's phone", async () => {
    deps = memoryDeps({ policies: { paused: true } });
    const error = envelopeOf(await callTool("book", bookArgs()));
    expect(error.code).toBe("paused");
    expect(error.details).toEqual({ phone: "+1 212-555-0142" });
    expect(error.next_action).toBe("Tell the person to call the shop at +1 212-555-0142.");
  });

  it("returns idempotency_conflict for a used key with different arguments", async () => {
    const args = bookArgs();
    expect((await callTool("book", args)).isError).toBeFalsy();
    const error = envelopeOf(await callTool("book", { ...args, start: "2026-11-14T16:00:00-05:00" }));
    expect(error.code).toBe("idempotency_conflict");
    expect(error.next_action).toMatch(/new idempotency_key/);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["no arguments", {}, "service_id"],
    ["a missing customer_name", { service_id: "haircut", start: SLOT, idempotency_key: "abcd-1234" }, "customer_name"],
    ["a blank customer_name", bookArgs({ customer_name: "   " }), "customer_name"],
    ["an 81-character customer_name", bookArgs({ customer_name: "x".repeat(81) }), "customer_name"],
    ["a start without an offset", bookArgs({ start: "2026-11-14T14:30:00" }), "start"],
    ["a numeric start", bookArgs({ start: 1763148600 }), "start"],
    ["a missing idempotency_key", { service_id: "haircut", start: SLOT, customer_name: "Maya" }, "idempotency_key"],
    ["a 7-character idempotency_key", bookArgs({ idempotency_key: "1234567" }), "idempotency_key"],
  ])("returns the invalid_request envelope for %s", async (_label, args, field) => {
    const error = envelopeOf(await callTool("book", args));
    expect(error.code).toBe("invalid_request");
    expect(error.details).toMatchObject({ field });
    expect(error.next_action.length).toBeGreaterThan(0);
  });
});

describe("MCP get_booking and cancel", () => {
  it("runs the whole loop: list → policies → availability → book (and replay) → get → cancel (and replay) → get", async () => {
    const services = (await callTool("list_services")).structuredContent as ListServicesResult;
    expect(services.services.map((s) => s.id)).toContain("haircut");

    const policies = (await callTool("get_policies")).structuredContent as GetPoliciesResult;
    expect(policies.policies.cancelWindowHours).toBe(24);

    const avail = (await callTool("get_availability", { service_id: "haircut", ...SAT })).structuredContent as GetAvailabilityResult;
    const start = avail.slots.find((s) => s.start === SLOT)!.start;

    const bookKey = key();
    const booked = await callTool("book", bookArgs({ start, idempotency_key: bookKey }));
    expect(booked.isError).toBeFalsy();
    const { booking } = booked.structuredContent as BookResult;

    const rebooked = await callTool("book", bookArgs({ start, idempotency_key: bookKey }));
    expect(rebooked.isError).toBeFalsy();
    expect((rebooked.structuredContent as BookResult).booking).toEqual(booking);
    expect(rebooked.content[0].text).toContain(
      "(replayed: this is the booking from your earlier call with the same idempotency_key)",
    );

    const fetched = await callTool("get_booking", { booking_id: booking.id });
    expect(fetched.isError).toBeFalsy();
    expect(fetched.structuredContent).toEqual({ booking } satisfies GetBookingResult);
    expect(fetched.content[0].text).toContain("Status: confirmed.");

    const cancelKey = key();
    const cancelled = await callTool("cancel", { booking_id: booking.id, idempotency_key: cancelKey });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.structuredContent).toEqual({
      booking: { ...booking, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    } satisfies CancelResult);
    const text = cancelled.content[0].text;
    expect(text).toContain("Status: cancelled.");
    expect(text).toContain("the $10 deposit is released");
    expect(text).toContain("nothing was charged or refunded");
    expect(text).not.toContain("replayed");

    const recancelled = await callTool("cancel", { booking_id: booking.id, idempotency_key: cancelKey });
    expect(recancelled.isError).toBeFalsy();
    expect(recancelled.structuredContent).toEqual(cancelled.structuredContent);
    expect(recancelled.content[0].text).toContain("(replayed:");

    const after = await callTool("get_booking", { booking_id: booking.id });
    expect((after.structuredContent as GetBookingResult).booking.status).toBe("cancelled");
  });

  it("cancel inside 24 hours says the shop keeps the deposit", async () => {
    const booked = await callTool("book", bookArgs({ start: "2026-11-10T10:00:00-05:00" }));
    const { booking } = booked.structuredContent as BookResult;
    const cancelled = await callTool("cancel", { booking_id: booking.id, idempotency_key: key() });
    expect((cancelled.structuredContent as CancelResult).depositEffect).toBe("captured");
    expect(cancelled.content[0].text).toContain("the shop keeps the $10 deposit as a late-cancellation fee");
  });

  it("returns booking_not_found for an unknown id from get_booking and cancel", async () => {
    const id = "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c";
    for (const result of [
      await callTool("get_booking", { booking_id: id }),
      await callTool("cancel", { booking_id: id, idempotency_key: key() }),
    ]) {
      const error = envelopeOf(result);
      expect(error.code).toBe("booking_not_found");
      expect(error.details).toEqual({ booking_id: id });
    }
  });

  it("returns not_cancellable when cancelling a cancelled booking with a new key", async () => {
    const { booking } = (await callTool("book", bookArgs())).structuredContent as BookResult;
    expect((await callTool("cancel", { booking_id: booking.id, idempotency_key: key() })).isError).toBeFalsy();
    const error = envelopeOf(await callTool("cancel", { booking_id: booking.id, idempotency_key: key() }));
    expect(error.code).toBe("not_cancellable");
    expect(error.details).toMatchObject({ status: "cancelled" });
  });

  it("returns idempotency_conflict when a cancel key is reused for another booking", async () => {
    const one = ((await callTool("book", bookArgs())).structuredContent as BookResult).booking;
    const two = ((await callTool("book", bookArgs({ start: "2026-11-14T16:00:00-05:00" }))).structuredContent as BookResult)
      .booking;
    const reused = key();
    expect((await callTool("cancel", { booking_id: one.id, idempotency_key: reused })).isError).toBeFalsy();
    const error = envelopeOf(await callTool("cancel", { booking_id: two.id, idempotency_key: reused }));
    expect(error.code).toBe("idempotency_conflict");
  });

  it.each<[string, string, Record<string, unknown>, string]>([
    ["get_booking", "no arguments", {}, "booking_id"],
    ["cancel", "no arguments", {}, "booking_id"],
    ["cancel", "a missing idempotency_key", { booking_id: "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c" }, "idempotency_key"],
  ])("%s returns the invalid_request envelope for %s", async (tool, _label, args, field) => {
    const error = envelopeOf(await callTool(tool, args));
    expect(error.code).toBe("invalid_request");
    expect(error.details).toMatchObject({ field });
  });
});

describe("agentNameFrom", () => {
  it("reads the MCP client's name from the 2026-07-28 request envelope", () => {
    const ctx = { mcpReq: { envelope: { "io.modelcontextprotocol/clientInfo": { name: "claude-ai", version: "1.0" } } } };
    expect(agentNameFrom(ctx)).toBe("claude-ai");
  });

  it("falls back to 'unknown agent' when the request carries no client name", () => {
    expect(agentNameFrom(undefined)).toBe("unknown agent");
    expect(agentNameFrom({ mcpReq: {} })).toBe("unknown agent");
    expect(agentNameFrom({ mcpReq: { envelope: { "io.modelcontextprotocol/clientInfo": { name: "  " } } } })).toBe(
      "unknown agent",
    );
  });
});
