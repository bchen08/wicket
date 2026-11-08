import { OAuthError, OAuthErrorCode, type AuthInfo, type McpServer } from "@modelcontextprotocol/server";
import { withMcpAuth } from "mcp-handler";
import { z } from "zod";
import type { Booking } from "../../types/frontdesk";
import type { ListMyBookingsResult } from "../../types/oauth";
import type { Clock } from "../clock";
import { normalizePhone } from "../consent/crypto";
import { syncDeposit } from "../deposits/deposits";
import { BOOKINGS_PAST_DAYS, MAX_CUSTOMER_NAME, NUL, requireShop, withApprovalOrigin, type FrontDeskDeps } from "../frontdesk/service";
import { getFrontDeskDeps } from "../frontdesk/deps";
import { FrontDeskError } from "../frontdesk/errors";
import { getSigninStore } from "../oauth/deps";
import { RESOURCE_METADATA_PATH, SCOPE } from "../oauth/metadata";
import type { Customer, SigninStore } from "../oauth/store";

// Who the person is: the customer an agent signed in as (connector sign-in, docs/connector-signin.md).
//
// The gate on /api/mcp (withCustomerSignin, wrapping the route's handler in mcp-handler's withMcpAuth):
//   - no token: served exactly as before, except two calls that only make sense signed in, which get
//     HTTP 401 with WWW-Authenticate (resource_metadata, scope) so the client shows its sign-in step and
//     retries: list_my_bookings, and book without a customer_name;
//   - a valid access token: the tools see the customer (customerFrom): book fills the name and phone,
//     list_my_bookings lists their bookings;
//   - an unknown or expired token: 401, so the client refreshes it or signs in again.

/** The signed-in person, as the tools see them. */
export type SignedInCustomer = Customer;

// ---- Signing in (the /signin form) ----

/** The name typed on /signin: trimmed, 1–80 characters, no control characters; null if it isn't one. */
export function parseCustomerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_CUSTOMER_NAME || /[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}

/**
 * The mobile number typed on /signin as E.164, or null. International format ("+44 7700 900123") works
 * anywhere; a 10-digit number ("401 555 0123", "(401) 555-0123") or 11 digits starting with 1 is taken as
 * a US number, since the shop is in New York.
 */
export function parseMobile(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const international = normalizePhone(value);
  if (international) return international;
  const digits = value.replace(/[\s\-().]/g, "");
  if (/^[2-9]\d{9}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

/**
 * Sign the person in at the shop: the customer with this phone, created if new, with `name` as their name.
 * Where texting is on, /signin only gets here once the code texted to the number was entered
 * (lib/server/oauth/authorize.ts). Where it's off, anyone who types a number signs in as that number's customer.
 */
export function signInCustomer(store: SigninStore, shopSlug: string, name: string, phone: string): Promise<Customer> {
  return store.upsertCustomer(shopSlug, phone, name);
}

// ---- The gate (/api/mcp) ----

/** true when a book field the customer can fill is absent: missing, null or blank. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Why this anonymous request needs the person signed in, or null when it can be served as it is. Only
 * tools/call requests for list_my_bookings, or for book without a customer_name, need it. Reads a copy
 * of the body, so the MCP handler can still read it.
 */
export async function signinNeededFor(request: Request): Promise<string | null> {
  if (request.method !== "POST" || !(request.headers.get("content-type") ?? "").includes("application/json")) return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null; // The MCP handler answers a malformed body.
  }
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!message || typeof message !== "object" || (message as { method?: unknown }).method !== "tools/call") continue;
    const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params;
    if (params?.name === "list_my_bookings") return "Sign in to Front Desk to see your bookings.";
    if (params?.name === "book") {
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      if (isBlank(args.customer_name)) {
        return "Sign in to Front Desk to book as yourself, or call book again with customer_name.";
      }
    }
  }
  return null;
}

/** What the gate needs to check a token. */
export type GateDeps = { store: SigninStore; clock: Clock };

/** The app's gate deps: the sign-in store and Front Desk's clock. Resolved only when a request carries a token. */
const appGateDeps = (): GateDeps => ({ store: getSigninStore(), clock: getFrontDeskDeps().clock });

/**
 * The AuthInfo for a valid access token; throws OAuthError (→ 401) for an unknown or expired one. Expiry is
 * checked here on Front Desk's clock, so AuthInfo carries no expiresAt for withMcpAuth to check again.
 */
export async function verifyAccessToken(deps: GateDeps, token: string): Promise<AuthInfo> {
  const found = token.includes(NUL) ? null : await deps.store.getToken(token, "access");
  if (!found) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown access token. Refresh it, or sign in again.");
  if (found.token.expiresAt.getTime() <= deps.clock.now().getTime()) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token has expired. Refresh it.");
  }
  return {
    token,
    clientId: found.token.clientId,
    scopes: found.token.scope.split(" ").filter(Boolean),
    extra: { customer: found.customer },
  };
}

/**
 * Wrap the MCP route's handler in the gate. Anonymous requests reach `handler` untouched (and never touch
 * the sign-in store), apart from the two calls signinNeededFor names; a request with a token reaches it
 * only with a valid one, as req.auth, which the tools read through customerFrom.
 */
export function withCustomerSignin(
  handler: (request: Request) => Promise<Response>,
  gateDeps: () => GateDeps = appGateDeps,
): (request: Request) => Promise<Response> {
  return (request) => {
    const verify = async (req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
      if (bearerToken) return verifyAccessToken(gateDeps(), bearerToken);
      const reason = await signinNeededFor(req);
      if (reason) throw new OAuthError(OAuthErrorCode.InvalidToken, reason);
      return undefined;
    };
    return withMcpAuth(handler, verify, {
      required: false,
      // The challenge points at this deployment's own metadata, like every other link Front Desk builds.
      resourceUrl: new URL(request.url).origin,
      resourceMetadataPath: RESOURCE_METADATA_PATH,
      requiredScopes: [SCOPE],
    })(request);
  };
}

/** The signed-in customer for a tool call (ctx.http.authInfo, set by the gate), or null when anonymous. */
export function customerFrom(ctx: { http?: { authInfo?: AuthInfo } } | undefined): SignedInCustomer | null {
  const customer = ctx?.http?.authInfo?.extra?.customer as Partial<Customer> | undefined;
  return customer && typeof customer.id === "string" && typeof customer.name === "string" && typeof customer.phone === "string"
    ? { id: customer.id, shopSlug: String(customer.shopSlug), name: customer.name, phone: customer.phone }
    : null;
}

/**
 * book's raw arguments with customer_name and customer_phone filled from the signed-in customer, each only
 * when the agent sent none. The number then works like any customer_phone: stored, and texted the approval
 * link where texting is on.
 */
export function bookArgsFor(rawArgs: unknown, customer: SignedInCustomer | null): unknown {
  if (!customer) return rawArgs;
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  return {
    ...args,
    customer_name: isBlank(args.customer_name) ? customer.name : args.customer_name,
    customer_phone: isBlank(args.customer_phone) ? customer.phone : args.customer_phone,
  };
}

// ---- list_my_bookings ----

/** The most bookings list_my_bookings returns. */
export const MAX_MY_BOOKINGS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far ahead lazy expiry looks before listing: further than any shop books. */
const EXPIRY_AHEAD_DAYS = 400;

/**
 * The customer's bookings at the shop that end within the last 7 days or later, of any status, sorted by
 * start (at most 50). Lapsed holds are expired first and deposits awaiting payment checked with Stripe, so
 * none is stale; a booking awaiting approval carries its approval link.
 */
export async function listMyBookings(
  deps: FrontDeskDeps,
  shopSlug: string,
  customer: SignedInCustomer,
): Promise<ListMyBookingsResult> {
  await requireShop(deps, shopSlug);
  const now = deps.clock.now();
  const since = new Date(now.getTime() - BOOKINGS_PAST_DAYS * DAY_MS);
  await deps.store.expireStaleHolds(shopSlug, { start: since, end: new Date(now.getTime() + EXPIRY_AHEAD_DAYS * DAY_MS) }, now);
  const listed = await deps.store.listCustomerBookings(shopSlug, customer.id, since, MAX_MY_BOOKINGS + 1);
  const bookings = await Promise.all(listed.slice(0, MAX_MY_BOOKINGS).map((b) => syncDeposit(deps, b)));
  return {
    customer: { name: customer.name, phone: customer.phone },
    bookings: bookings.map((b) => withApprovalOrigin(deps, b)),
    truncated: listed.length > MAX_MY_BOOKINGS,
  };
}

/** list_my_bookings' text: who, then one line per booking with its id. */
export function myBookingsText(result: ListMyBookingsResult, shopName: string, now: Date): string {
  const who = `${result.customer.name} (${result.customer.phone})`;
  if (result.bookings.length === 0) {
    return `${who} is signed in and has no bookings at ${shopName} from the last ${BOOKINGS_PAST_DAYS} days on. Use book to make one.`;
  }
  const line = (b: Booking) => {
    const past = Date.parse(b.end) <= now.getTime() ? " (past)" : "";
    return `- ${b.serviceName}, ${b.display}${past}: ${b.status}. Booking id: ${b.id}.`;
  };
  return [
    `${who} is signed in. Their bookings at ${shopName} (from the last ${BOOKINGS_PAST_DAYS} days on):`,
    ...result.bookings.map(line),
    ...(result.truncated ? [`Only the first ${MAX_MY_BOOKINGS} are shown.`] : []),
    "Pass a booking id to get_booking for details or to cancel (tell the person the deposit consequence first).",
  ].join("\n");
}

/** The pieces of mcp.ts the tool reuses, passed in so this module doesn't import mcp.ts (which imports it). */
export type ToolKit = {
  bookingSchema: z.ZodType<Booking>;
  errorResult: (err: unknown) => { isError: boolean; content: { type: "text"; text: string }[] };
};

/** Register list_my_bookings. Called from registerFrontDeskTools. */
export function registerCustomerTools(
  server: McpServer,
  getDeps: () => FrontDeskDeps,
  shopSlug: string,
  kit: ToolKit,
): void {
  server.registerTool(
    "list_my_bookings",
    {
      title: "List my bookings",
      description:
        "List the signed-in person's bookings at Hart's Barbers: every status, from the last 7 days on, sorted by start, " +
        "each with its booking id (use it with get_booking and cancel), service, time, status, deposit and, while it " +
        "awaits approval, the approval link. Also returns who is signed in (customer.name and customer.phone). " +
        "Takes no arguments. It needs the person signed in to Front Desk: if they aren't, the request asks them to " +
        "sign in (name and mobile number) and is retried. Read-only, apart from recording holds that ran out. " +
        'On failure the result has isError: true and its text is JSON: { error: { code, message, next_action } }; follow next_action.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        customer: z.object({ name: z.string(), phone: z.string().describe("E.164.") }),
        bookings: z.array(kit.bookingSchema),
        truncated: z.boolean().describe(`true if there are more than ${MAX_MY_BOOKINGS}.`),
      }),
      annotations: { title: "List my bookings", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }] },
    },
    async (_args, ctx) => {
      try {
        const customer = customerFrom(ctx);
        if (!customer) {
          // The gate answers 401 before an anonymous call gets here; this is for a handler mounted without it.
          throw new FrontDeskError(
            "invalid_request",
            "list_my_bookings needs the person signed in to Front Desk.",
            "Ask the person to connect Front Desk and sign in with their name and mobile number, then call it again.",
          );
        }
        const deps = getDeps();
        const result = await listMyBookings(deps, shopSlug, customer);
        const shop = await requireShop(deps, shopSlug);
        return {
          content: [{ type: "text", text: myBookingsText(result, shop.name, deps.clock.now()) }],
          structuredContent: result,
        };
      } catch (err) {
        return kit.errorResult(err);
      }
    },
  );
}
