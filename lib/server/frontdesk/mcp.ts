import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type {
  ApiError,
  GetAvailabilityInput,
  GetAvailabilityResult,
  ListServicesResult,
} from "../../types/frontdesk";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_WINDOW_DAYS } from "../engine/availability";
import { toApiError } from "./errors";
import { getAvailability, listServices, type FrontDeskDeps } from "./service";

// The agent door: Front Desk's MCP tools. Transport lives in app/api/mcp/route.ts.

/** Every tool is scoped to this shop until multi-shop routing lands. */
// TODO(ring-1): let agents pick the shop (by slug or URL) instead of hard-coding it.
export const DEFAULT_SHOP_SLUG = "harts";

export const SERVER_INSTRUCTIONS = [
  "Front Desk lets you check appointment availability at small independent businesses.",
  "It currently serves one shop: Hart's Barbers, in the America/New_York time zone.",
  "Call list_services first to get service ids, then get_availability for open start times.",
  "Booking is not available yet: these tools are read-only and never change anything.",
].join(" ");

// ---- Schemas (zod) mirrored from lib/types/frontdesk.ts ----

const rfc3339 = (description: string) => z.string().meta({ format: "date-time", description });

// Value checks (formats, ranges, unknown ids) happen in the handler, not here, so a bad value
// comes back as the ApiError envelope with a next_action. The schema still advertises the
// constraints (format, minimum, maximum) so agents can get it right the first time.
// Only a missing field or a wrong JSON type is rejected by the SDK before our handler runs.
const getAvailabilityInputSchema = z.object({
  service_id: z.string().describe('A service id from list_services, e.g. "haircut".'),
  from: rfc3339(
    "Window start, inclusive. RFC 3339 date-time with a time zone offset, " +
      'e.g. "2026-11-14T00:00:00-05:00" or "2026-11-14T05:00:00Z".',
  ),
  to: rfc3339(
    "Window end, exclusive. RFC 3339 date-time with a time zone offset, " +
      `e.g. "2026-11-15T00:00:00-05:00". Must be after from and at most ${MAX_WINDOW_DAYS} days after it.`,
  ),
  limit: z
    .number()
    .optional()
    .meta({
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum number of slots to return, a whole number from 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
    }),
});

const shopSchema = z.object({
  slug: z.string(),
  name: z.string(),
  timezone: z.string().describe("IANA time zone, e.g. America/New_York."),
});

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  durationMin: z.number().int().describe("Appointment length in minutes."),
  priceCents: z.number().int().describe("Price in integer US cents (3500 = $35.00)."),
  depositCents: z.number().int().describe("Deposit in integer US cents. 0 = no deposit."),
});

const listServicesOutputSchema = z.object({
  shop: shopSchema,
  services: z.array(serviceSchema),
});

const slotSchema = z.object({
  start: z.string().describe("RFC 3339 with the shop's offset."),
  end: z.string().describe("RFC 3339 with the shop's offset."),
  staffId: z.string(),
  display: z.string().describe('Human-readable start, e.g. "Sat 14 Nov, 2:30 pm EST".'),
});

const getAvailabilityOutputSchema = z.object({
  slots: z.array(slotSchema),
  truncated: z.boolean().describe("true if more slots exist in the window than were returned."),
});

// Compile-time guards: the zod schemas must produce exactly the contract types.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractChecks: [
  Exact<z.infer<typeof listServicesOutputSchema>, ListServicesResult>,
  Exact<z.infer<typeof getAvailabilityOutputSchema>, GetAvailabilityResult>,
  Exact<z.infer<typeof getAvailabilityInputSchema>, GetAvailabilityInput>,
] = [true, true, true];
void contractChecks;

// ---- Formatting ----

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function listServicesText(result: ListServicesResult): string {
  const lines = result.services.map((s) => {
    const deposit = s.depositCents > 0 ? `${formatUsd(s.depositCents)} deposit` : "no deposit";
    return `- ${s.name} (id: ${s.id}): ${s.durationMin} min, ${formatUsd(s.priceCents)}, ${deposit}`;
  });
  return [
    `${result.shop.name} — times are in ${result.shop.timezone}.`,
    ...lines,
    "Prices are in US dollars here and in integer cents in structuredContent.",
  ].join("\n");
}

function availabilityText(result: GetAvailabilityResult, serviceId: string): string {
  if (result.slots.length === 0) {
    return `No open times for ${serviceId} in that window. Try a later or wider window (up to ${MAX_WINDOW_DAYS} days).`;
  }
  const lines = result.slots.map((s) => `- ${s.display} (start ${s.start}, with ${s.staffId})`);
  const more = result.truncated
    ? "\nMore times exist. To see them, call again with from set one minute after the last start above."
    : "";
  return `${result.slots.length} open start time(s) for ${serviceId}:\n${lines.join("\n")}${more}`;
}

/**
 * A tool error whose text is the ApiError envelope as JSON.
 *
 * The envelope is deliberately NOT sent as structuredContent: clients (MCP Inspector among them)
 * validate structuredContent against the tool's outputSchema even when isError is true, so an
 * envelope there would be rejected before the agent ever saw next_action.
 */
export function errorResult(err: unknown) {
  const envelope: ApiError = toApiError(err);
  if (envelope.error.code === "internal") {
    console.error("[frontdesk/mcp] internal error", err);
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A web-standard `(Request) => Promise<Response>` MCP handler (Streamable HTTP, stateless)
 * serving Front Desk's tools. Mounted by app/api/mcp/route.ts; also driven directly by tests.
 */
export function createFrontDeskMcpHandler(
  deps: FrontDeskDeps,
): (request: Request) => Promise<Response> {
  return createMcpHandler((server) => registerFrontDeskTools(server, () => deps), {
    serverInfo: { name: "front-desk", version: "0.1.0" },
    instructions: SERVER_INSTRUCTIONS,
  });
}

/** Register Front Desk's tools on an MCP server. `getDeps` is called once per tool call. */
export function registerFrontDeskTools(
  server: McpServer,
  getDeps: () => FrontDeskDeps,
  shopSlug: string = DEFAULT_SHOP_SLUG,
): void {
  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "List every service Hart's Barbers offers, with its id, name, duration in minutes, price and deposit. " +
        "Prices are US dollars in the text and integer cents in structuredContent (priceCents, depositCents; " +
        "depositCents 0 means no deposit). Also returns the shop's IANA time zone, which every appointment time uses. " +
        "Call this first to get a service_id for get_availability. Takes no arguments. Read-only.",
      inputSchema: z.object({}),
      outputSchema: listServicesOutputSchema,
      annotations: { title: "List services", ...READ_ONLY },
    },
    async () => {
      try {
        const result = await listServices(getDeps(), shopSlug);
        return {
          content: [{ type: "text", text: listServicesText(result) }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_availability",
    {
      title: "Get availability",
      description:
        "Find open appointment start times at Hart's Barbers for one service. " +
        "from and to are RFC 3339 date-times with an offset (e.g. 2026-11-14T00:00:00-05:00); the window is [from, to) " +
        `and may be at most ${MAX_WINDOW_DAYS} days long. ` +
        `Returns up to limit slots (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}), earliest first. Each slot has start and end ` +
        "as RFC 3339 in the shop's time zone (America/New_York), the staffId, and a display string like " +
        '"Sat 14 Nov, 2:30 pm EST". Starts are on a 15-minute grid; past times are never returned. ' +
        "truncated: true means more slots exist; call again with from one minute after the last start. " +
        "On failure the result has isError: true and its text is JSON: { error: { code, message, next_action, details? } }; " +
        "follow next_action. Read-only: this does not book or hold anything.",
      inputSchema: getAvailabilityInputSchema,
      outputSchema: getAvailabilityOutputSchema,
      annotations: { title: "Get availability", ...READ_ONLY },
    },
    async (args) => {
      try {
        const result = await getAvailability(getDeps(), shopSlug, args);
        return {
          content: [{ type: "text", text: availabilityText(result, args.service_id) }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
