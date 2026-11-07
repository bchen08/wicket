import { describe, expect, it } from "vitest";
import type { ApiError, GetAvailabilityResult, ListServicesResult } from "../../types/frontdesk";
import { fixedClock } from "../clock";
import { createHardcodedCatalog } from "./hardcoded-catalog";
import { createFrontDeskMcpHandler } from "./mcp";

// End to end through the real MCP handler (the same one /api/mcp mounts), speaking
// stateless Streamable HTTP JSON-RPC. "Now" is Sat 7 Nov 2026, so the coming Saturday is 14 Nov.
const clock = fixedClock(new Date("2026-11-07T12:00:00-05:00"));
const handler = createFrontDeskMcpHandler({ clock, catalog: createHardcodedCatalog(clock) });

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
  it("lists both tools as read-only, with RFC 3339 inputs documented", async () => {
    const { tools } = await rpc<{
      tools: {
        name: string;
        description: string;
        annotations?: Record<string, unknown>;
        inputSchema: { properties?: Record<string, { description?: string; format?: string }> };
        outputSchema?: unknown;
      }[];
    }>("tools/list");

    expect(tools.map((t) => t.name).sort()).toEqual(["get_availability", "list_services"]);
    for (const tool of tools) {
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
