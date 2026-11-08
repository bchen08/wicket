import { CLIENT_INFO_META_KEY, type McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type {
  ApiError,
  Booking,
  BookInput,
  BookResult,
  CancelInput,
  CancelResult,
  GetAvailabilityInput,
  GetAvailabilityResult,
  GetBookingInput,
  GetBookingResult,
  GetPoliciesResult,
  ListServicesResult,
} from "../../types/frontdesk";
import { DateTime } from "luxon";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_WINDOW_DAYS, formatDisplay } from "../engine/availability";
import { APPROVAL_HOLD_MINUTES, DEPOSIT_PAY_MINUTES } from "../engine/lifecycle";
import { toApiError } from "./errors";
import {
  book,
  cancelBooking,
  getAvailability,
  getBooking,
  getPolicies,
  listServices,
  MAX_ALTERNATIVES,
  MAX_CUSTOMER_NAME,
  MAX_MANDATE_CAP_CENTS,
  minutesInWords,
  parseBookArgs,
  parseCancelArgs,
  parseGetAvailabilityArgs,
  parseGetBookingArgs,
  pluralize,
  UNKNOWN_AGENT,
  type BookOutcome,
  type FrontDeskDeps,
  type GetBookingOutcome,
} from "./service";
import { bookArgsFor, customerFrom, registerCustomerTools } from "../identity/customer";

// The agent door: Front Desk's MCP tools. Transport lives in app/api/mcp/route.ts.

/** Every tool is scoped to this shop until multi-shop routing lands. */
// TODO(ring-2): let agents pick the shop (by slug or URL) instead of hard-coding it.
export const DEFAULT_SHOP_SLUG = "harts";

export const SERVER_INSTRUCTIONS = [
  "Front Desk lets you book appointments at small independent businesses.",
  "It currently serves one shop: Hart's Barbers, in the America/New_York time zone.",
  "The flow: list_services for service ids, get_policies for the shop's rules, get_availability for open start times,",
  "then book with one of those starts and the customer's name. If the person gave you limits (a price or deposit",
  "cap, or a time window), send them as mandate: the server refuses anything outside them.",
  "Before booking, tell the person the shop's rules: the deposit, the cancellation window and the no-show rule.",
  `No booking is final until the person approves it themselves: book holds the slot for ${APPROVAL_HOLD_MINUTES} minutes`,
  "and returns an approval link (booking.approval.url). Send the person that link right away; they open it and",
  "approve or decline. If the service has a deposit, approving takes them to a payment page to place it as a hold",
  `on their card (awaiting_deposit, for ${DEPOSIT_PAY_MINUTES} minutes); paying confirms the booking. The hold is charged only`,
  "for a no-show or a late cancellation. Then call get_booking to check the status: confirmed",
  "(approved and, if needed, paid), awaiting_deposit (approved, deposit not paid yet: send the same link again),",
  "cancelled (declined) or expired (the hold ran out or the deposit wasn't paid in time; book again if they still want it).",
  "While the hold is on, get_booking returns the same link again, so you never need to book twice to get it.",
  "cancel works on a hold too. On a confirmed booking it follows the shop's cancellation policy (the deposit is",
  "released or kept depending on how close the start is), so tell the person the consequence before cancelling.",
  "People can sign in to Front Desk (name and mobile number) from this connector: then book uses their name and number",
  "(leave customer_name out) and list_my_bookings lists their bookings with ids for get_booking and cancel.",
].join(" ");

/** How every tool reports a failure. Each description adds the codes that tool can return. */
const ERROR_FORMAT =
  "On failure the result has isError: true and its text is JSON: { error: { code, message, next_action, details? } }; " +
  "follow next_action.";

// ---- Schemas (zod) mirrored from lib/types/frontdesk.ts ----

// The input schema only ADVERTISES types and constraints (via .meta, which becomes the JSON
// Schema agents see); it accepts any value. All checking happens in the parse*Args functions
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

const policiesSchema = z.object({
  leadTimeMin: z.number().int().describe("Minimum minutes between now and an appointment's start."),
  horizonDays: z.number().int().describe("How many days ahead a service without a deposit can be booked."),
  depositHorizonDays: z.number().int().describe("How many days ahead a service with a deposit can be booked."),
  cancelWindowHours: z
    .number()
    .int()
    .describe(
      "Cancelling at least this many hours before the start releases the deposit; later (before the start) the shop keeps it.",
    ),
  paused: z.boolean().describe("true: the shop isn't taking bookings. Tell the person to call the shop."),
  phone: z.string().nullable().describe("The shop's phone number, or null if it hasn't set one."),
  depositRule: z.string().describe('Plain-language deposit rule to read to the person. "" if not set.'),
  lateCancelRule: z.string().describe('Plain-language late-cancellation rule. "" if not set.'),
  noShowRule: z.string().describe('Plain-language no-show rule. "" if not set.'),
});

const getPoliciesOutputSchema = z.object({
  shop: shopSchema,
  policies: policiesSchema,
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

const bookingIdInput = advertise({
  type: "string",
  format: "uuid",
  description: "The booking's id: booking.id (a UUID) from book.",
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
      `1–${MAX_CUSTOMER_NAME} characters. Leave it out to book as the person signed in to Front Desk (their name ` +
      "and number); if they haven't signed in yet, they're asked to. Otherwise ask the user if you don't know it.",
  }),
  mandate: advertise({
    type: "object",
    additionalProperties: false,
    description:
      "Optional: the limits the person gave you. The server refuses a booking outside them (outside_mandate), and the " +
      "person sees them on the approval page. Leave out any limit they didn't set; don't invent one.",
    properties: {
      priceCapCents: {
        type: "integer",
        minimum: 0,
        maximum: MAX_MANDATE_CAP_CENTS,
        description: "The most the service may cost, in integer US cents (5000 = $50.00).",
      },
      depositCapCents: {
        type: "integer",
        minimum: 0,
        maximum: MAX_MANDATE_CAP_CENTS,
        description: "The largest deposit the service may require, in integer US cents.",
      },
      window: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        description: "The appointment must start and end inside [from, to).",
        properties: {
          from: { type: "string", format: "date-time", description: "RFC 3339 with offset, e.g. 2026-11-14T09:00:00-05:00." },
          to: { type: "string", format: "date-time", description: "RFC 3339 with offset, after from." },
        },
      },
    },
  }),
} satisfies Record<keyof BookInput, z.ZodType>; // same keys as the contract, no more, no fewer

const BOOK_REQUIRED = ["service_id", "start"] as const;

const bookInputSchema = z.object(bookInputShape).meta({ required: [...BOOK_REQUIRED] });

const getBookingInputShape = {
  booking_id: bookingIdInput,
} satisfies Record<keyof GetBookingInput, z.ZodType>;

const GET_BOOKING_REQUIRED = ["booking_id"] as const;

const getBookingInputSchema = z.object(getBookingInputShape).meta({ required: [...GET_BOOKING_REQUIRED] });

const cancelInputShape = {
  booking_id: bookingIdInput,
} satisfies Record<keyof CancelInput, z.ZodType>;

const CANCEL_REQUIRED = ["booking_id"] as const;

const cancelInputSchema = z.object(cancelInputShape).meta({ required: [...CANCEL_REQUIRED] });

const bookingSchema = z.object({
  id: z.string().describe("Booking id (UUID)."),
  shopSlug: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  staffId: z.string(),
  start: z.string().describe("RFC 3339 with the shop's offset."),
  end: z.string().describe("RFC 3339 with the shop's offset."),
  display: z.string().describe('Human-readable start, e.g. "Sat 14 Nov, 2:30 pm EST".'),
  status: z
    .enum(["awaiting_approval", "awaiting_deposit", "confirmed", "cancelled", "expired", "completed", "no_show"])
    .describe(
      "awaiting_approval: held until the person approves with the link. awaiting_deposit: approved, held until the " +
        "person pays the deposit from the same link. awaiting_approval, awaiting_deposit and confirmed " +
        "hold the time; cancelled, expired, completed and no_show are final.",
    ),
  customer: z.object({
    displayName: z.string(),
    approved: z.boolean().describe("true once the person tapped Approve on the approval link."),
    phone: z.string().optional().describe("The phone number the person gave when approving (E.164), if any."),
  }),
  agent: z.object({ name: z.string().describe("Best-effort label for the booking agent: the client's self-reported name.") }),
  depositCents: z.number().int().describe("Deposit the service requires, in integer US cents. 0 = none."),
  deposit: z
    .object({
      amountCents: z.number().int().describe("The deposit in integer US cents (the same as depositCents)."),
      state: z
        .enum(["none", "awaiting_payment", "held", "captured", "released", "not_collected"])
        .describe(
          "none: nothing asked for (no deposit, or not approved yet). awaiting_payment: approved, the person must pay " +
            "the hold. held: on their card, not charged. captured: charged (no-show or late cancellation). released: " +
            "dropped, they keep their money. not_collected: confirmed without collecting it.",
        ),
      payUrl: z
        .string()
        .optional()
        .describe("The payment page, while awaiting_payment. Send the person the approval link instead: it has the Pay button."),
      payBy: z.string().optional().describe("While awaiting_payment: when the booking expires unpaid, RFC 3339."),
      actionFailed: z
        .object({
          action: z.enum(["capture", "release"]),
          message: z.string(),
          at: z.string(),
        })
        .optional()
        .describe("For the shop: the payment provider refused to capture or release the deposit."),
    })
    .describe("Where the deposit stands."),
  createdAt: z.string().describe("RFC 3339."),
  approval: z
    .object({
      url: z.string().describe("Send this link to the person: they approve or decline there, and pay the deposit if needed."),
      expiresAt: z.string().describe("When the hold lapses, RFC 3339 (while awaiting_deposit: when the deposit must be paid by)."),
    })
    .optional()
    .describe("Present while the booking awaits approval or its deposit, in book's and get_booking's results."),
});

const bookOutputSchema = z.object({ booking: bookingSchema });

const getBookingOutputSchema = z.object({ booking: bookingSchema });

const cancelOutputSchema = z.object({
  booking: bookingSchema,
  depositEffect: z
    .enum(["none", "released", "captured"])
    .describe("What the shop's policy does with the deposit: none (no deposit), released, or captured (kept by the shop)."),
  depositCollected: z
    .boolean()
    .describe("true when a deposit held on the card is captured or released by this change (see booking.deposit.state)."),
});

// Compile-time guards: the schemas must match the contract types exactly (including optional
// fields), so `tsc` fails if either side drifts.
type Exact<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
const contractChecks: [
  Exact<z.infer<typeof listServicesOutputSchema>, ListServicesResult>,
  Exact<z.infer<typeof getPoliciesOutputSchema>, GetPoliciesResult>,
  Exact<z.infer<typeof getAvailabilityOutputSchema>, GetAvailabilityResult>,
  Exact<(typeof GET_AVAILABILITY_REQUIRED)[number], RequiredKeys<GetAvailabilityInput>>,
  Exact<z.infer<typeof bookOutputSchema>, BookResult>,
  Exact<(typeof BOOK_REQUIRED)[number], RequiredKeys<BookInput>>,
  Exact<z.infer<typeof getBookingOutputSchema>, GetBookingResult>,
  Exact<(typeof GET_BOOKING_REQUIRED)[number], RequiredKeys<GetBookingInput>>,
  Exact<z.infer<typeof cancelOutputSchema>, CancelResult>,
  Exact<(typeof CANCEL_REQUIRED)[number], RequiredKeys<CancelInput>>,
] = [true, true, true, true, true, true, true, true, true, true];
void contractChecks;

// ---- Formatting ----

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "$10" for whole dollars, "$10.50" otherwise. For sentences; lists use formatUsd. */
function formatUsdShort(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatUsd(cents);
}

/** "Tell the person to call the shop at +1 …." (or without the number when there is none). */
function callTheShop(phone: string | null): string {
  const number = phone?.trim();
  return `Tell the person to call the shop${number ? ` at ${number}` : ""}.`;
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

/** The shop's rules in plain language, for the agent to relay. */
export function policiesText({ shop, policies: p }: GetPoliciesResult): string {
  const lines = [
    `${shop.name} booking rules (times are in ${shop.timezone}):`,
    p.paused
      ? `- Bookings are PAUSED: ${shop.name} isn't taking bookings right now. Don't book. ${callTheShop(p.phone)}`
      : "- Bookings are open.",
    `- Book at least ${minutesInWords(p.leadTimeMin)} ahead.`,
    `- Services without a deposit can be booked up to ${pluralize(p.horizonDays, "day")} ahead; ` +
      `services with a deposit up to ${pluralize(p.depositHorizonDays, "day")} ahead.`,
    `- Cancelling at least ${pluralize(p.cancelWindowHours, "hour")} before the start releases the deposit; ` +
      "cancelling later, but before the start, means the shop keeps it. After the start, cancel is refused.",
    p.phone?.trim() ? `- Phone: ${p.phone.trim()}.` : "- The shop hasn't listed a phone number.",
  ];
  const rules = [
    ["Deposit", p.depositRule],
    ["Late cancellation", p.lateCancelRule],
    ["No-show", p.noShowRule],
  ] as const;
  for (const [label, text] of rules) {
    if (text.trim() !== "") lines.push(`${label}: ${text.trim()}`);
  }
  lines.push(
    "Read these rules to the person before booking. A deposit is asked for after they approve the booking, as a hold " +
      "on their card that is charged only under these rules.",
  );
  return lines.join("\n");
}

function availabilityText(result: GetAvailabilityResult, serviceId: string): string {
  if (result.slots.length === 0) {
    return (
      `No open times for ${serviceId} in that window. Try a later or wider window (up to ${MAX_WINDOW_DAYS} days). ` +
      "Starts inside the shop's lead time or beyond how far ahead it books are never offered (see get_policies)."
    );
  }
  const lines = result.slots.map((s) => `- ${s.display} (start ${s.start}, with ${s.staffId})`);
  const more = result.truncated
    ? "\nMore times exist. To see them, call again with from set one minute after the last start above."
    : "";
  return `${result.slots.length} open start time(s) for ${serviceId}:\n${lines.join("\n")}${more}`;
}

/** get_availability's text when the shop has paused bookings. */
function pausedAvailabilityText({ shop, policies }: GetPoliciesResult): string {
  return `${shop.name} isn't taking bookings right now, so there are no open times. ${callTheShop(policies.phone)}`;
}


/** An RFC 3339 instant as "Mon 9 Nov, 12:10 pm UTC-5", in its own offset. Only when book gave no holdDisplay. */
function displayInstant(rfc3339: string): string {
  return formatDisplay(DateTime.fromISO(rfc3339, { setZone: true }));
}

/**
 * What the agent must do after book: "Hold placed until <time>. Send <name> this link to approve:
 * <url>. Then call get_booking to check the status."
 */
export function bookText({ booking, staffName, holdDisplay, depositsOn }: BookOutcome): string {
  const name = booking.customer.displayName;
  const amount = formatUsdShort(booking.depositCents);
  const deposit =
    booking.depositCents === 0
      ? "This service needs no deposit."
      : depositsOn
        ? `After approving, ${name} pays a ${amount} deposit hold on the same page (charged only for a no-show or a late ` +
          `cancellation); the booking is confirmed once it's paid. Nothing was charged yet.`
        : `This service has a ${amount} deposit, but the shop isn't collecting deposits yet, so nothing will be charged.`;
  const lines = [`Held ${booking.serviceName} with ${staffName}, ${booking.display}, for ${name}. It is not confirmed yet.`];
  if (booking.approval) {
    lines.push(
      `Hold placed until ${holdDisplay ?? displayInstant(booking.approval.expiresAt)}. Send ${name} this link to approve: ` +
        `${booking.approval.url}. Then call get_booking to check the status.`,
    );
  }
  lines.push(
    deposit,
    `Booking id: ${booking.id}. Don't book this time again while the hold is on. If ${name} declines or the hold ` +
      "runs out, the time is freed.",
  );
  return lines.join("\n");
}

/** What happened to the money, after cancelText's policy sentence. */
function moneyNote({ booking, depositEffect, depositCollected }: CancelResult): string {
  if (depositEffect === "none") return "";
  if (!depositCollected) return " No deposit was held on the card, so nothing was charged or refunded.";
  if (booking.deposit.actionFailed) return " The payment provider didn't accept the change yet; the shop will sort it out.";
  return depositEffect === "captured" ? " The held deposit was charged." : " The hold on the card was released.";
}

/** E.g. "Cancelled Haircut, Sat 14 Nov, 2:30 pm EST, for Maya. Status: cancelled." plus the deposit effect in words. */
export function cancelText(result: CancelResult): string {
  const { booking, depositEffect } = result;
  const deposit = formatUsdShort(booking.depositCents);
  const effect = {
    none: "This booking has no deposit, so there's nothing to release or keep.",
    released: `Under the shop's policy the ${deposit} deposit is released: the customer keeps it.`,
    captured: `Under the shop's policy the shop keeps the ${deposit} deposit as a late-cancellation fee.`,
  }[depositEffect];
  return [
    `Cancelled ${booking.serviceName}, ${booking.display}, for ${booking.customer.displayName}. Status: ${booking.status}.`,
    `${effect}${moneyNote(result)}`,
    `Booking id: ${booking.id}.`,
  ].join("\n");
}

/** What a status means for the agent, in get_booking's text. */
function statusNote({ booking, declined }: GetBookingOutcome): string | null {
  const name = booking.customer.displayName;
  switch (booking.status) {
    case "awaiting_approval": {
      const link = booking.approval
        ? `Waiting for ${name} to approve with this link: ${booking.approval.url} (the hold lapses at ` +
          `${displayInstant(booking.approval.expiresAt)}).`
        : `Waiting for ${name} to approve with the link from book (the hold lasts ${APPROVAL_HOLD_MINUTES} minutes from booking).`;
      return `${link} Remind them if needed, then call get_booking again.`;
    }
    case "awaiting_deposit": {
      const amount = formatUsdShort(booking.depositCents);
      const by = booking.approval ? ` by ${displayInstant(booking.approval.expiresAt)}` : "";
      const link = booking.approval ? `: ${booking.approval.url}` : "";
      return (
        `${name} approved it, but it isn't confirmed until they pay the ${amount} deposit hold${by}. ` +
        `Send them the same approval link again if needed (its page has the Pay button)${link}. Then call get_booking again.`
      );
    }
    case "confirmed":
      return booking.customer.approved ? `${name} approved it. It is confirmed.` : "It is confirmed.";
    case "expired":
      return booking.customer.approved
        ? `${name} approved it but didn't pay the deposit in time, so the time is free again. Book again if they still want it.`
        : `The hold ran out before ${name} approved, so the time is free again. Book again if they still want it.`;
    case "cancelled":
      return declined ? `${name} declined it, so the time is free again.` : null;
    default:
      return null;
  }
}

/** The deposit's state in get_booking's text: "Deposit: $10 (held on the card, not charged)." */
const DEPOSIT_WORDS: Record<Booking["deposit"]["state"], string> = {
  none: "not asked for yet",
  awaiting_payment: "waiting for payment",
  held: "held on the card, not charged",
  captured: "charged",
  released: "released",
  not_collected: "not collected",
};

/** E.g. "Haircut, Sat 14 Nov, 2:30 pm EST, for Maya. Status: confirmed." plus what the status means. */
function bookingText(outcome: GetBookingOutcome): string {
  const { booking } = outcome;
  const deposit =
    booking.depositCents > 0 ? `Deposit: ${formatUsdShort(booking.depositCents)} (${DEPOSIT_WORDS[booking.deposit.state]}).` : "No deposit.";
  const note = statusNote(outcome);
  return [
    `${booking.serviceName}, ${booking.display}, for ${booking.customer.displayName}. Status: ${booking.status}.`,
    ...(note ? [note] : []),
    `${deposit} Booking id: ${booking.id}.`,
  ].join("\n");
}

/**
 * The calling agent's name, best effort: the MCP client's self-reported name (clientInfo.name).
 * On the 2026-07-28 protocol every request carries it in its _meta envelope. Stateless 2025-era
 * requests don't (it was only sent with initialize), so those get "unknown agent".
 * TODO(ring-2): a signed-in agent identity instead of a self-reported label.
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
    serverInfo: { name: "front-desk", version: "0.5.0" },
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
        "Call this first to get a service_id, then get_policies for the shop's rules. Takes no arguments. Read-only. " +
        `${ERROR_FORMAT} code internal: retry once.`,
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
    "get_policies",
    {
      title: "Get booking rules",
      description:
        "Read Hart's Barbers' booking rules. Call it before booking and tell the person the rules. " +
        "leadTimeMin: the minimum minutes between now and a start. horizonDays / depositHorizonDays: how many days " +
        "ahead a service without / with a deposit can be booked. cancelWindowHours: cancelling at least this many hours " +
        "before the start releases the deposit; later (but before the start) the shop keeps it as a late fee. " +
        "paused: true means the shop isn't taking bookings; tell the person to call phone. depositRule, lateCancelRule " +
        "and noShowRule are plain-language rules to read to the person. No money is collected yet. " +
        `Takes no arguments. Read-only. ${ERROR_FORMAT} code internal: retry once.`,
      inputSchema: z.object({}),
      outputSchema: getPoliciesOutputSchema,
      annotations: { title: "Get booking rules", ...READ_ONLY },
    },
    async () => {
      try {
        const result = await getPolicies(getDeps(), shopSlug);
        return {
          content: [{ type: "text", text: policiesText(result) }],
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
        '"Sat 14 Nov, 2:30 pm EST". Starts are on a 15-minute grid. Only starts the shop\'s rules allow are returned ' +
        "(get_policies): nothing inside the lead time, nothing beyond how far ahead the service can be booked, and " +
        "nothing at all while the shop is paused (then the text says to call the shop). " +
        "truncated: true means more slots exist; call again with from one minute after the last start. " +
        `${ERROR_FORMAT} code invalid_request: fix the arguments as next_action says. ` +
        "code not_found: unknown service_id; call list_services. " +
        "Read-only: this does not book or hold anything.",
      inputSchema: getAvailabilityInputSchema,
      outputSchema: getAvailabilityOutputSchema,
      annotations: { title: "Get availability", ...READ_ONLY },
    },
    async (rawArgs) => {
      try {
        const args = parseGetAvailabilityArgs(rawArgs);
        const deps = getDeps();
        const result = await getAvailability(deps, shopSlug, args);
        let text = availabilityText(result, args.service_id);
        if (result.slots.length === 0) {
          const rules = await getPolicies(deps, shopSlug);
          if (rules.policies.paused) text = pausedAvailabilityText(rules);
        }
        return {
          content: [{ type: "text", text }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "book",
    {
      title: "Book an appointment",
      description:
        `Hold an appointment at Hart's Barbers for ${APPROVAL_HOLD_MINUTES} minutes until the person approves it. ` +
        "Nothing is final until they do: the result has status awaiting_approval and booking.approval.url, a link to " +
        "send the person right away. They open it and approve (→ confirmed) or decline (→ cancelled); if nobody " +
        "answers in time the hold expires and the time is freed. If the service has a deposit (depositCents > 0), " +
        "approving takes them to a payment page for a hold on their card (→ awaiting_deposit until paid, then " +
        `confirmed; unpaid after ${DEPOSIT_PAY_MINUTES} minutes → expired). Then call ` +
        "get_booking to check the status. Only call book once the person has chosen a time and heard the shop's rules " +
        "(get_policies). start must be one of the starts get_availability just returned for the same service_id " +
        "(RFC 3339 with offset, e.g. 2026-11-14T14:30:00-05:00); any other time is refused. " +
        `customer_name is the name the booking is under (1–${MAX_CUSTOMER_NAME} characters); leave it out to book as ` +
        "the person signed in to Front Desk. " +
        "mandate (optional): the person's limits (priceCapCents, depositCapCents, window { from, to }); the server " +
        "refuses a booking outside them. " +
        "Call it once per booking: calling again for the same time gets slot_taken while the hold is on. " +

        `${ERROR_FORMAT} ` +
        `code slot_taken: someone else just booked that time; details.alternatives has up to ${MAX_ALTERNATIVES} nearby ` +
        "open starts to offer the person, or call get_availability again. " +
        "code too_soon: inside the shop's lead time; details.earliest is the earliest allowed start, so call " +
        "get_availability from there. " +
        "code too_far: beyond how far ahead the shop books this service; pick a start before details.latest. " +
        "code outside_hours: not a bookable time for that service; call get_availability and choose one of its starts. " +
        "code paused: the shop isn't taking bookings; tell the person to call the shop (details.phone). " +
        "code outside_mandate: the service or time breaks the person's limit (details.field: price_cap, deposit_cap or " +
        "window); ask them to widen it, or choose a different service or time. " +
        "code invalid_request: fix the arguments as next_action says.",
      inputSchema: bookInputSchema,
      outputSchema: bookOutputSchema,
      annotations: {
        title: "Book an appointment",
        readOnlyHint: false,
        destructiveHint: false,
        // Each call places a new hold (or is slot_taken), so repeating it isn't a no-op.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawArgs, ctx) => {
      try {
        const args = parseBookArgs(bookArgsFor(rawArgs, customerFrom(ctx)));
        const outcome = await book(getDeps(), shopSlug, args, agentNameFrom(ctx), customerFrom(ctx));
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

  server.registerTool(
    "get_booking",
    {
      title: "Get a booking",
      description:
        "Read one booking at Hart's Barbers by its id (booking.id from book): the service, start, staff member, " +
        "customer name, deposit and status. Call it after sending the approval link to see what the person did: " +
        "awaiting_approval (not answered yet; booking.approval.url is the link to send them again if they lost it), " +
        "confirmed (approved; customer.approved is true, and customer.phone is set if they gave a number), cancelled " +
        "(declined, or cancelled by you or the shop), expired (the hold ran out or the deposit wasn't paid in time; book " +
        "again if they still want it), awaiting_deposit (approved, but the deposit isn't paid yet: send the person the " +
        "same booking.approval.url again; its page has the Pay button). Also completed or no_show. booking.deposit.state " +
        "says where the deposit stands. " +
        "For a signed-in person, list_my_bookings gives their booking ids. Read-only, apart from recording that a hold ran out. " +
        `${ERROR_FORMAT} code booking_not_found: no booking with that id at this shop; check the id. ` +
        "code invalid_request: fix the arguments as next_action says.",
      inputSchema: getBookingInputSchema,
      outputSchema: getBookingOutputSchema,
      annotations: { title: "Get a booking", ...READ_ONLY },
    },
    async (rawArgs) => {
      try {
        const args = parseGetBookingArgs(rawArgs);
        const outcome = await getBooking(getDeps(), shopSlug, args);
        const result: GetBookingResult = { booking: outcome.booking };
        return {
          content: [{ type: "text", text: bookingText(outcome) }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "cancel",
    {
      title: "Cancel a booking",
      description:
        "Cancel a booking at Hart's Barbers. A hold that is still awaiting approval can be cancelled any time, and " +
        "frees the time at once. A confirmed booking follows the shop's cancellation policy (get_policies): " +
        "cancelling at least cancelWindowHours before the start releases the deposit; cancelling later, but before " +
        "the start, captures it (the shop keeps it as a late fee); after the start the booking is not_cancellable. " +
        "Tell the person the consequence and get their go-ahead before cancelling. " +
        "A booking still awaiting its deposit can be cancelled any time; its payment page is closed. " +
        "Returns the booking (status cancelled), depositEffect (none, released or captured) and depositCollected " +
        "(true when a deposit held on the card was charged or released; booking.deposit.state shows the result). " +
        "Cancelling again is not_cancellable (it's already cancelled), so a retry never cancels twice. " +
        "For a signed-in person, list_my_bookings gives their booking ids. " +
        `${ERROR_FORMAT} code not_cancellable: the booking is already final (details.status), its hold ran out, or it has started; ` +
        "don't retry, tell the person to call the shop. " +
        "code booking_not_found: no booking with that id at this shop; check the id. " +
        "code invalid_request: fix the arguments as next_action says.",
      inputSchema: cancelInputSchema,
      outputSchema: cancelOutputSchema,
      annotations: {
        title: "Cancel a booking",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawArgs) => {
      try {
        const args = parseCancelArgs(rawArgs);
        const outcome = await cancelBooking(getDeps(), shopSlug, args);
        const result: CancelResult = {
          booking: outcome.booking,
          depositEffect: outcome.depositEffect,
          depositCollected: outcome.depositCollected,
        };
        return {
          content: [{ type: "text", text: cancelText(outcome) }],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerCustomerTools(server, getDeps, shopSlug, { bookingSchema, errorResult });
}
