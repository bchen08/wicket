import { beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  BookResult,
  GetAvailabilityResult,
  ListServicesResult,
} from "../../types/frontdesk";
import { agentNameFrom, createFrontDeskMcpHandler } from "./mcp";
import type { FrontDeskDeps } from "./service";
import { EXAMPLE_BOOKINGS, memoryDeps } from "./test-support";

// End to end through the real MCP handler (the same one /api/mcp mounts), speaking
// stateless Streamable HTTP JSON-RPC. "Now" is Sat 7 Nov 2026, so the coming Saturday is 14 Nov.
// Each test gets a fresh in-memory store holding the two example bookings on that Saturday.
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

describe("MCP /api/mcp", () => {
  it("lists the two read tools as read-only, with RFC 3339 inputs documented", async () => {
    const { tools } = await rpc<{
      tools: {
        name: string;
        description: string;
        annotations?: Record<string, unknown>;
        inputSchema: { properties?: Record<string, { description?: string; format?: string }> };
        outputSchema?: unknown;
      }[];
    }>("tools/list");

    expect(tools.map((t) => t.name).sort()).toEqual(["book", "get_availability", "list_services"]);
    for (const tool of tools.filter((t) => t.name !== "book")) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.outputSchema).toBeDefined();
    }
    const avail = tools.find((t) => t.name === "get_availability")!;
    expect(avail.description).toMatch(/14 days/);
    expect(avail.description).toMatch(/America\/New_York/);
    expect(avail.inputSchema.properties?.from?.description).toMatch(/RFC 3339/);
    expect(avail.inputSchema.properties?.to?.description).toMatch(/RFC 3339/);
    expect(avail.inputSchema.properties?.from?.format).toBe("date-time");
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

  it("get_availability returns Saturday slots that skip lunch and the example bookings", async () => {
    const result = await callTool("get_availability", {
      service_id: "haircut",
      from: "2026-11-14T00:00:00-05:00",
      to: "2026-11-15T00:00:00-05:00",
      limit: 50,
    });
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
    const result = await callTool("get_availability", {
      service_id: "perm",
      from: "2026-11-14T00:00:00-05:00",
      to: "2026-11-15T00:00:00-05:00",
    });
    expect(result.isError).toBe(true);
    // Not in structuredContent: clients validate that against outputSchema even on errors.
    expect(result.structuredContent).toBeUndefined();
    const envelope = JSON.parse(result.content[0].text) as ApiError;
    expect(envelope.error.code).toBe("not_found");
    expect(envelope.error.next_action).toMatch(/list_services/);
  });

  const SAT = { from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" };

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
    const result = await callTool("get_availability", args);
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text) as ApiError;
    expect(envelope.error.code).toBe("invalid_request");
    expect(envelope.error.next_action.length).toBeGreaterThan(0);
  });

  it("treats limit: null as omitted (default 20)", async () => {
    const result = await callTool("get_availability", { service_id: "haircut", ...SAT, limit: null });
    expect(result.isError).toBeFalsy();
    const { slots, truncated } = result.structuredContent as GetAvailabilityResult;
    expect(slots).toHaveLength(20);
    expect(truncated).toBe(true);
  });

  it("advertises types, formats, limits and required fields in the input schema", async () => {
    const { tools } = await rpc<{
      tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, Record<string, unknown>> } }[];
    }>("tools/list");
    const schema = tools.find((t) => t.name === "get_availability")!.inputSchema;
    expect([...(schema.required ?? [])].sort()).toEqual(["from", "service_id", "to"]);
    expect(schema.properties.service_id).toMatchObject({ type: "string" });
    expect(schema.properties.from).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties.to).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
  });
});

describe("MCP book tool", () => {
  const SLOT = "2026-11-14T14:30:00-05:00";
  const bookArgs = { service_id: "haircut", start: SLOT, customer_name: "Maya" };

  it("is advertised as a write that isn't destructive or idempotent, with actionable inputs", async () => {
    const { tools } = await rpc<{
      tools: {
        name: string;
        description: string;
        annotations?: Record<string, unknown>;
        inputSchema: { required?: string[]; properties: Record<string, Record<string, unknown>> };
        outputSchema?: unknown;
      }[];
    }>("tools/list");
    const tool = tools.find((t) => t.name === "book")!;
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tool.outputSchema).toBeDefined();
    expect(tool.description).toMatch(/immediately/);
    expect(tool.description).toMatch(/No deposit is collected/);
    expect(tool.description).toMatch(/not verified/);
    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(["customer_name", "service_id", "start"]);
    expect(tool.inputSchema.properties.start).toMatchObject({ type: "string", format: "date-time" });
    expect(String(tool.inputSchema.properties.start.description)).toMatch(/returned by get_availability/);
    expect(tool.inputSchema.properties.customer_name).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
  });

  it("books a slot, returns BookResult and a summary, and the slot disappears", async () => {
    const result = await callTool("book", bookArgs);
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
      createdAt: "2026-11-07T12:00:00-05:00",
    });
    expect(result.content[0].text).toContain(
      "Booked Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. A $10 deposit will be required once deposits are enabled",
    );
    expect(result.content[0].text).toContain(booking.id);

    const after = await callTool("get_availability", {
      service_id: "haircut",
      from: "2026-11-14T14:00:00-05:00",
      to: "2026-11-14T16:00:00-05:00",
    });
    const starts = (after.structuredContent as GetAvailabilityResult).slots.map((s) => s.start.slice(11, 16));
    expect(starts).not.toContain("14:30");
  });

  it("refuses the same slot twice with slot_taken", async () => {
    expect((await callTool("book", bookArgs)).isError).toBeFalsy();
    const second = await callTool("book", { ...bookArgs, customer_name: "Jo" });
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toBeUndefined();
    const envelope = JSON.parse(second.content[0].text) as ApiError;
    expect(envelope.error.code).toBe("slot_taken");
    expect(envelope.error.next_action).toBe(
      "Someone just took that time. Call get_availability again and choose another start.",
    );
  });

  it("returns slot_taken through the envelope when the database refuses an overlap", async () => {
    // Simulate a race: availability (the catalog) still shows the slot free, but the store has it.
    const base = deps;
    deps = { ...base, catalog: { ...base.catalog, getBusyIntervals: async () => [] } };
    expect((await callTool("book", bookArgs)).isError).toBeFalsy();
    const raced = await callTool("book", { ...bookArgs, customer_name: "Jo" });
    expect(raced.isError).toBe(true);
    const envelope = JSON.parse(raced.content[0].text) as ApiError;
    expect(envelope.error.code).toBe("slot_taken");
    expect(envelope.error.next_action).toBe(
      "Someone just took that time. Call get_availability again and choose another start.",
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["no arguments", {}, "service_id"],
    ["a missing customer_name", { service_id: "haircut", start: SLOT }, "customer_name"],
    ["a blank customer_name", { ...bookArgs, customer_name: "   " }, "customer_name"],
    ["an 81-character customer_name", { ...bookArgs, customer_name: "x".repeat(81) }, "customer_name"],
    ["a start without an offset", { ...bookArgs, start: "2026-11-14T14:30:00" }, "start"],
    ["a numeric start", { ...bookArgs, start: 1763148600 }, "start"],
  ])("returns the invalid_request envelope for %s", async (_label, args, field) => {
    const result = await callTool("book", args);
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text) as ApiError;
    expect(envelope.error.code).toBe("invalid_request");
    expect(envelope.error.details).toMatchObject({ field });
    expect(envelope.error.next_action.length).toBeGreaterThan(0);
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
