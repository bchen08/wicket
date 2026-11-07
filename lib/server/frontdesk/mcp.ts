import { CLIENT_INFO_META_KEY, type McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type {
  ApiError,
  BookInput,
  BookResult,
  GetAvailabilityInput,
  GetAvailabilityResult,
  ListServicesResult,
} from "../../types/frontdesk";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_WINDOW_DAYS } from "../engine/availability";
import { toApiError } from "./errors";
import {
  book,
  getAvailability,
  listServices,
  MAX_CUSTOMER_NAME,
  parseBookArgs,
  parseGetAvailabilityArgs,
  UNKNOWN_AGENT,
  type BookOutcome,
  type FrontDeskDeps,
} from "./service";

// The agent door: Front Desk's MCP tools. Transport lives in app/api/mcp/route.ts.

/** Every tool is scoped to this shop until multi-shop routing lands. */
// TODO(ring-1): let agents pick the shop (by slug or URL) instead of hard-coding it.
export const DEFAULT_SHOP_SLUG = "harts";

export const SERVER_INSTRUCTIONS = [
  "Front Desk lets you book appointments at small independent businesses.",
  "It currently serves one shop: Hart's Barbers, in the America/New_York time zone.",
  "Call list_services to get service ids, then get_availability for open start times,",
  "then book with one of those starts and the customer's name.",
  "book confirms immediately. No deposit is collected yet, and the customer's identity is not verified.",
].join(" ");

// ---- Schemas (zod) mirrored from lib/types/frontdesk.ts ----

// The input schema only ADVERTISES types and constraints (via .meta, which becomes the JSON
// Schema agents see); it accepts any value. All checking happens in parseGetAvailabilityArgs
// and the engine, so every failure (missing field, wrong type, bad value) comes back as the
// ApiError envelope with a next_action instead of the SDK's plain-text validation error.
const advertise = (jsonSchema: Record<string, unknown>) => z.unknown().optional().meta(jsonSchema);

const getAvailabilityInputShape = {
  service_id: advertise({
    type: "string",
    description: 'A service id from list_services, e.g. "haircut".',
  }),
  from: advertise({
    type: "string",
    format: "date-time",
    description:
      "Window start, inclusive. RFC 3339 date-time with a time zone offset, " +
      'e.g. "2026-11-14T00:00:00-05:00" or "2026-11-14T05:00:00Z".',
  }),
  to: advertise({
    type: "string",
    format: "date-time",
    description:
      "Window end, exclusive. RFC 3339 date-time with a time zone offset, " +
      `e.g. "2026-11-15T00:00:00-05:00". Must be after from and at most ${MAX_WINDOW_DAYS} days ` +
      `(${MAX_WINDOW_DAYS * 24} hours) after it.`,
  }),
  limit: advertise({
    type: "integer",
    minimum: 1,
    maximum: MAX_LIMIT,
    description: `Maximum number of slots to return, a whole number from 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
  }),
} satisfies Record<keyof GetAvailabilityInput, z.ZodType>; // same keys as the contract, no more, no fewer

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
const GET_AVAILABILITY_REQUIRED = ["service_id", "from", "to"] as const;

const getAvailabilityInputSchema = z
  .object(getAvailabilityInputShape)
  .meta({ required: [...GET_AVAILABILITY_REQUIRED] });

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

const bookInputShape = {
  service_id: advertise({
    type: "string",
    description: 'A service id from list_services, e.g. "haircut".',
  }),
  start: advertise({
    type: "string",
    format: "date-time",
    description:
      "Appointment start. Must be a start returned by get_availability for this service, copied exactly, " +
      'e.g. "2026-11-14T14:30:00-05:00" (RFC 3339 with a time zone offset). Any other time is refused.',
  }),
  customer_name: advertise({
    type: "string",
    minLength: 1,
    maxLength: MAX_CUSTOMER_NAME,
    description:
      `The name the booking is under, as the customer wants the shop to see it, e.g. "Maya" or "Maya Lopez". ` +
      `1–${MAX_CUSTOMER_NAME} characters. Ask the user if you don't know it.`,
  }),
} satisfies Record<keyof BookInput, z.ZodType>; // same keys as the contract, no more, no fewer

const BOOK_REQUIRED = ["service_id", "start", "customer_name"] as const;

const bookInputSchema = z.object(bookInputShape).meta({ required: [...BOOK_REQUIRED] });

const bookingSchema = z.object({
  id: z.string().describe("Booking id (UUID)."),
  shopSlug: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  staffId: z.string(),
  start: z.string().describe("RFC 3339 with the shop's offset."),
  end: z.string().describe("RFC 3339 with the shop's offset."),
  display: z.string().describe('Human-readable start, e.g. "Sat 14 Nov, 2:30 pm EST".'),
  status: z.enum(["confirmed", "cancelled"]),
  customer: z.object({
    displayName: z.string(),
    verified: z.literal(false).describe("Always false for now: the customer's identity is not checked."),
  }),
  agent: z.object({ name: z.string().describe("Best-effort label for the booking agent. Unverified.") }),
  depositCents: z
    .number()
    .int()
    .describe("Deposit the service requires, in integer US cents. Not collected yet. 0 = none."),
  createdAt: z.string().describe("RFC 3339."),
});

const bookOutputSchema = z.object({ booking: bookingSchema });

// Compile-time guards: the schemas must match the contract types exactly (including optional
// fields), so `tsc` fails if either side drifts.
type Exact<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
const contractChecks: [
  Exact<z.infer<typeof listServicesOutputSchema>, ListServicesResult>,
  Exact<z.infer<typeof getAvailabilityOutputSchema>, GetAvailabilityResult>,
  Exact<(typeof GET_AVAILABILITY_REQUIRED)[number], RequiredKeys<GetAvailabilityInput>>,
  Exact<z.infer<typeof bookOutputSchema>, BookResult>,
  Exact<(typeof BOOK_REQUIRED)[number], RequiredKeys<BookInput>>,
] = [true, true, true, true, true];
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

/** "$10" for whole dollars, "$10.50" otherwise. For sentences; lists use formatUsd. */
function formatUsdShort(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatUsd(cents);
}

/** E.g. "Booked Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. A $10 deposit will be required once deposits are enabled." */
export function bookText({ booking, staffName }: BookOutcome): string {
  const deposit =
    booking.depositCents > 0
      ? `A ${formatUsdShort(booking.depositCents)} deposit will be required once deposits are enabled; nothing was charged.`
      : "This service needs no deposit.";
  return [
    `Booked ${booking.serviceName} with ${staffName}, ${booking.display}, for ${booking.customer.displayName}. ${deposit}`,
    `Booking id: ${booking.id}. It is confirmed now; don't call book again for it.`,
  ].join("\n");
}

/**
 * The calling agent's name, best effort: the MCP client's self-reported name (clientInfo.name).
 * On the 2026-07-28 protocol every request carries it in its _meta envelope. Stateless 2025-era
 * requests don't (it was only sent with initialize), so those get "unknown agent".
 * TODO(ring-2): a verified agent identity instead of a self-reported label.
 */
export function agentNameFrom(ctx: { mcpReq?: { envelope?: unknown } } | undefined): string {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
  return typeof info?.name === "string" && info.name.trim() !== "" ? info.name.trim() : UNKNOWN_AGENT;
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
 * Pass a function to resolve deps lazily, on each tool call (the route does, so a configuration
 * error becomes a tool error instead of a crash at module load).
 */
export function createFrontDeskMcpHandler(
  deps: FrontDeskDeps | (() => FrontDeskDeps),
): (request: Request) => Promise<Response> {
  const getDeps = typeof deps === "function" ? deps : () => deps;
  return createMcpHandler((server) => registerFrontDeskTools(server, getDeps), {
    serverInfo: { name: "front-desk", version: "0.2.0" },
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
        `and may be at most ${MAX_WINDOW_DAYS} days (${MAX_WINDOW_DAYS * 24} hours) long. ` +
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
    async (rawArgs) => {
      try {
        const args = parseGetAvailabilityArgs(rawArgs);
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

  // Deposits, idempotency and identity are deferred: see the TODOs on book() in service.ts.
  // TODO(ring-1): cancel and get_booking tools.
  server.registerTool(
    "book",
    {
      title: "Book an appointment",
      description:
        "Book an appointment at Hart's Barbers. The booking is confirmed immediately when this returns: " +
        "there is no hold or confirm step, so only call it once the user has chosen a time. " +
        "start must be one of the starts get_availability just returned for the same service_id " +
        "(RFC 3339 with offset, e.g. 2026-11-14T14:30:00-05:00); any other time is refused. " +
        `customer_name is the name the booking is under (1–${MAX_CUSTOMER_NAME} characters). ` +
        "No deposit is collected yet: depositCents says what the service will require once deposits are enabled. " +
        "The customer's identity is not verified. Not idempotent: don't repeat a call that succeeded. " +
        "On failure the result has isError: true and its text is JSON: { error: { code, message, next_action, details? } }. " +
        "code slot_taken means someone else just booked that time: call get_availability again and offer the user another start. " +
        "code invalid_request means fix the arguments as next_action says.",
      inputSchema: bookInputSchema,
      outputSchema: bookOutputSchema,
      annotations: {
        title: "Book an appointment",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawArgs, ctx) => {
      try {
        const args = parseBookArgs(rawArgs);
        const outcome = await book(getDeps(), shopSlug, args, agentNameFrom(ctx));
        const result: BookResult = { booking: outcome.booking };
        return {
          content: [{ type: "text", text: bookText(outcome) }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
