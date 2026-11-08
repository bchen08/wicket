import { DateTime } from "luxon";
import type {
  AgentPolicies,
  AlertKind,
  AlertStatus,
  BookInput,
  Booking,
  BookingEventType,
  BookingsResponse,
  BookingTransitionResult,
  BookResult,
  CancelInput,
  CancelResult,
  GetAvailabilityInput,
  GetAvailabilityResult,
  GetBookingInput,
  GetBookingResult,
  GetPoliciesResult,
  ListServicesResult,
  Mandate,
  Policies,
  Service,
  Shop,
  Slot,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { newApprovalToken, normalizePhone } from "../consent/crypto";
import {
  bookingBounds,
  checkStart,
  computeAvailability,
  formatDisplay,
  nearbySlots,
  validateRequest,
  type BookingRules,
  type StartCheck,
  type StartCheckInput,
} from "../engine/availability";
import { decide, type LifecycleAction, type ManageAction } from "../engine/lifecycle";
import { depositCollected, moveDeposit, syncDeposit } from "../deposits/deposits";
import type { DepositPayments } from "../deposits/payments";
import type { Notifier, OwnerAlert } from "../notify/notifier";
import type { TextSender } from "../notify/text-sender";
import { approvalLinkText, ownerAlertText } from "../notify/texts";
import { SlotTakenError, type BookingStore } from "./booking-store";
import type { BusyInterval, ShopCatalog } from "./catalog";
import { FrontDeskError } from "./errors";
import { DEFAULT_POLICIES } from "./policies";
import { parseRfc3339, toRfc3339 } from "./time";

// Transport-agnostic use cases behind the MCP tools and the UI routes. They take their
// dependencies as arguments so tests can pass a fixed clock and the in-memory store.
// Production wiring lives in deps.ts. The approval page's use cases are in lib/server/consent/approvals.ts.

export type FrontDeskDeps = {
  catalog: ShopCatalog;
  clock: Clock;
  store: BookingStore;
  notifier: Notifier;
  /**
   * Stripe, for deposits (lib/server/deposits). null when deposits are off (no STRIPE_SECRET_KEY): approving
   * then confirms at once, and a booking that needed a deposit shows it as not_collected.
   */
  payments: DepositPayments | null;
  /**
   * The origin approval links point at, without a trailing slash, e.g. "https://emergent.vercel.app".
   * Each route sets it to the origin of the request it's serving (withRequestOrigin), so links work on
   * previews and in production with no setting. createFrontDeskDeps starts it at http://localhost:3000.
   */
  baseUrl: string;
  /**
   * Sends texts (lib/server/notify/text-sender.ts): Photon or Twilio, whichever the environment configures.
   * null or absent: texting is off, and nothing is texted (approval links, owner alerts, sign-in codes).
   */
  texter?: TextSender | null;
};

/** `deps` with baseUrl set to the origin of `request`, so the bookings it returns link to where the caller is. */
export function withRequestOrigin(deps: FrontDeskDeps, request: Request): FrontDeskDeps {
  return { ...deps, baseUrl: new URL(request.url).origin };
}

/**
 * The booking as it leaves the server: its approval link (a path, from the store) gets deps.baseUrl in
 * front. Every use case that returns a booking passes it through here.
 */
export function withApprovalOrigin(deps: Pick<FrontDeskDeps, "baseUrl">, booking: Booking): Booking {
  if (!booking.approval || !booking.approval.url.startsWith("/")) return booking;
  return { ...booking, approval: { ...booking.approval, url: `${deps.baseUrl}${booking.approval.url}` } };
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export function shopNotFound(slug: string): FrontDeskError {
  return new FrontDeskError(
    "not_found",
    `No shop with slug "${slug}".`,
    "Check the shop slug. Front Desk currently serves one shop: harts.",
    { shop: slug },
  );
}

/** U+0000. Postgres text can't hold it (SQLSTATE 22021), so it never reaches a query or a stored row. */
export const NUL = "\u0000";

/** The shop, or a not_found FrontDeskError. A slug containing NUL is not_found without a query. */
export async function requireShop(deps: FrontDeskDeps, shopSlug: string): Promise<Shop> {
  if (shopSlug.includes(NUL)) throw shopNotFound(shopSlug);
  const shop = await deps.catalog.getShop(shopSlug);
  if (!shop) throw shopNotFound(shopSlug);
  return shop;
}

/** The shop's policies; DEFAULT_POLICIES if it has no row. Doesn't check that the shop exists. */
export async function policiesFor(deps: FrontDeskDeps, shopSlug: string): Promise<Policies> {
  return (await deps.catalog.getPolicies(shopSlug)) ?? { ...DEFAULT_POLICIES };
}

export function bookingNotFound(bookingId: string): FrontDeskError {
  return new FrontDeskError(
    "booking_not_found",
    `No booking with id "${bookingId}" at this shop.`,
    "Check the booking id. It is the booking.id (a UUID) that book returned, or that list_my_bookings lists for a signed-in person.",
    { booking_id: bookingId },
  );
}

/**
 * The booking if it exists and belongs to `shopSlug`; otherwise booking_not_found. Reading it expires
 * its hold first if that lapsed (store.refreshBooking), and asks Stripe about a deposit it's waiting for
 * (syncDeposit: paid → confirmed; unpaid past pay_by → expired), so a caller never sees a stale one.
 */
export async function requireBooking(deps: FrontDeskDeps, shopSlug: string, bookingId: string): Promise<Booking> {
  const booking = await deps.store.refreshBooking(bookingId, deps.clock.now());
  if (!booking || booking.shopSlug !== shopSlug) throw bookingNotFound(bookingId);
  return syncDeposit(deps, booking);
}

export const EVENT_FOR: Record<LifecycleAction, BookingEventType> = {
  cancel: "cancelled",
  complete: "completed",
  mark_no_show: "no_show",
  approve: "approved",
  decline: "declined",
  expire: "expired",
  confirm_deposit: "deposit.paid",
};

/** How many times transitionBooking re-reads and re-decides after losing a race. */
const MAX_TRANSITION_ATTEMPTS = 3;

/**
 * Apply an agent's or owner's lifecycle action (cancel, complete, mark_no_show), or the system's complete
 * (the nightly tidy-up, nightly.ts), to a booking: expire a lapsed hold first (requireBooking), decide()
 * against the shop's policies and the clock, then
 * store.transition() conditionally on the status it decided from, writing one event.
 * If another transition got there first (transition returns null), re-read the booking and decide
 * again, so the loser gets the right error (e.g. not_cancellable) instead of a stale success.
 * Then, after the commit, move the deposit in Stripe (moveDeposit: captured → capture the hold, released →
 * release it). A Stripe failure doesn't undo the change; it shows on booking.deposit.actionFailed.
 * Throws not_found (shop), booking_not_found, or decide()'s FrontDeskError.
 */
export async function transitionBooking(
  deps: FrontDeskDeps,
  shopSlug: string,
  bookingId: string,
  action: ManageAction,
  actor: "agent" | "owner" | "system",
): Promise<BookingTransitionResult> {
  await requireShop(deps, shopSlug);
  const policies = await policiesFor(deps, shopSlug);
  for (let attempt = 1; attempt <= MAX_TRANSITION_ATTEMPTS; attempt++) {
    const booking = await requireBooking(deps, shopSlug, bookingId);
    const decision = decide(booking, { type: action, actor }, deps.clock.now(), policies);
    if (decision instanceof FrontDeskError) throw decision;
    const collected = depositCollected(booking, decision.depositEffect);
    const updated = await deps.store.transition(booking.id, booking.status, decision.nextStatus, {
      actor,
      type: EVENT_FOR[action],
      data: {
        from: booking.status,
        to: decision.nextStatus,
        depositEffect: decision.depositEffect,
        depositCollected: collected,
      },
    });
    if (updated) {
      const moved = await moveDeposit(deps, booking, updated, decision.depositEffect);
      return { booking: withApprovalOrigin(deps, moved), depositEffect: decision.depositEffect, depositCollected: collected };
    }
  }
  throw new Error(`Booking ${bookingId} kept changing status during ${action}; gave up after ${MAX_TRANSITION_ATTEMPTS} attempts.`);
}

/** The shop and everything it sells. */
export async function listServices(
  deps: FrontDeskDeps,
  shopSlug: string,
): Promise<ListServicesResult> {
  const shop = await requireShop(deps, shopSlug);
  const services = await deps.catalog.listServices(shopSlug);
  return { shop, services };
}

/** The policies an agent sees: all but the owner's email and mobile, which only the owner routes show. */
export function agentPolicies(policies: Policies): AgentPolicies {
  const { ownerEmail, ownerMobile, ...rules } = policies;
  void ownerEmail;
  void ownerMobile;
  return rules;
}

/**
 * The shop and its booking rules (lead time, horizons, cancellation window, pause, phone, rule texts), for
 * agents (get_policies). The owner routes use getShopPolicies (owner.ts), which includes ownerEmail.
 */
export async function getPolicies(deps: FrontDeskDeps, shopSlug: string): Promise<GetPoliciesResult> {
  const shop = await requireShop(deps, shopSlug);
  return { shop, policies: agentPolicies(await policiesFor(deps, shopSlug)) };
}

// ---- Wording shared with the MCP text summaries ----

/** "1 hour", "30 days": `n` and `unit`, with an "s" unless n is 1. */
export function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A number of minutes in words: "2 hours", "45 minutes", "1 hour 30 minutes", "7 days". */
export function minutesInWords(minutes: number): string {
  const perDay = 24 * 60;
  if (minutes >= perDay && minutes % perDay === 0) return pluralize(minutes / perDay, "day");
  if (minutes >= 60 && minutes % 60 === 0) return pluralize(minutes / 60, "hour");
  if (minutes > 60) return `${pluralize(Math.floor(minutes / 60), "hour")} ${pluralize(minutes % 60, "minute")}`;
  return pluralize(minutes, "minute");
}

/** The shop's phone for people to call, or null if it has none. */
function shopPhone(policies: Policies): string | null {
  return policies.phone?.trim() || null;
}

// ---- Availability ----

/** Busy time without holds that lapsed by `now`: a stale hold never blocks a new booking. */
export function activeBusy(busy: BusyInterval[], now: Date): BusyInterval[] {
  return busy.filter((b) => b.heldUntil === undefined || b.heldUntil.getTime() > now.getTime());
}

function parseInstant(field: "from" | "to", value: string): Date {
  const parsed = parseRfc3339(value);
  if (!parsed) {
    throw new FrontDeskError(
      "invalid_request",
      `${field} is not an RFC 3339 date-time with an offset.`,
      `Send ${field} like 2026-11-14T09:00:00-05:00 (or with Z for UTC). A time zone offset is required.`,
      { field, value },
    );
  }
  return parsed;
}

function invalidField(field: string, message: string, nextAction: string, value: unknown): FrontDeskError {
  return new FrontDeskError("invalid_request", message, nextAction, { field, value: value ?? null });
}

/**
 * Check raw tool arguments (any JSON) and narrow them to GetAvailabilityInput.
 * Missing fields and wrong JSON types become invalid_request errors with a next_action,
 * the same as bad values, so an agent always gets the ApiError envelope.
 * `limit: null` is treated as omitted (some function-calling adapters send null for unset options).
 */
export function parseGetAvailabilityArgs(raw: unknown): GetAvailabilityInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { service_id, from, to, limit } = args;

  if (typeof service_id !== "string" || service_id.trim() === "") {
    throw invalidField(
      "service_id",
      "service_id is required and must be a non-empty string.",
      'Call list_services and pass one of its service ids, e.g. "haircut".',
      service_id,
    );
  }
  for (const [field, value] of [["from", from], ["to", to]] as const) {
    if (typeof value !== "string") {
      throw invalidField(
        field,
        `${field} is required and must be an RFC 3339 date-time string.`,
        `Send ${field} like 2026-11-14T09:00:00-05:00 (a time zone offset is required).`,
        value,
      );
    }
  }
  if (limit !== undefined && limit !== null && typeof limit !== "number") {
    throw invalidField(
      "limit",
      "limit must be a number.",
      "Omit limit to get up to 20 slots, or pass a whole number from 1 to 50.",
      limit,
    );
  }

  return {
    service_id,
    from: from as string,
    to: to as string,
    ...(typeof limit === "number" ? { limit } : {}),
  };
}

/** The parts of the shop's policies the availability engine applies. */
function bookingRules(policies: Policies): BookingRules {
  return {
    leadTimeMin: policies.leadTimeMin,
    horizonDays: policies.horizonDays,
    depositHorizonDays: policies.depositHorizonDays,
    paused: policies.paused,
  };
}

/** The shop's service with this id, or `error` built from the valid ids. */
async function findService(
  deps: FrontDeskDeps,
  shop: Shop,
  serviceId: string,
  error: (validIds: string[]) => FrontDeskError,
): Promise<Service> {
  const services = await deps.catalog.listServices(shop.slug);
  const service = services.find((s) => s.id === serviceId);
  if (!service) throw error(services.map((s) => s.id));
  return service;
}

/**
 * Bookable start times for one service in a window, under the shop's rules: nothing inside the
 * lead time, nothing beyond the horizon (the deposit horizon for a service with a deposit), and
 * nothing at all while the shop is paused ({ slots: [], truncated: false }).
 */
export async function getAvailability(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: GetAvailabilityInput,
): Promise<GetAvailabilityResult> {
  const from = parseInstant("from", input.from);
  const to = parseInstant("to", input.to);
  // Reject a bad window before asking the catalog for anything.
  validateRequest({ from, to, limit: input.limit });

  const shop = await requireShop(deps, shopSlug);
  const [service, policies] = await Promise.all([
    findService(
      deps,
      shop,
      input.service_id,
      (validIds) =>
        new FrontDeskError(
          "not_found",
          `No service with id "${input.service_id}" at ${shop.name}.`,
          "Call list_services to get valid service ids, then retry with one of them.",
          { service_id: input.service_id, valid_service_ids: validIds },
        ),
    ),
    policiesFor(deps, shopSlug),
  ]);
  if (policies.paused) return { slots: [], truncated: false };

  const now = deps.clock.now();
  const rules = bookingRules(policies);
  // Busy time only matters for the starts the rules allow: [max(from, earliest), min(to, latest)).
  // A slot may start just before the end of that range and run past it, so fetch busy time up to
  // there + duration; otherwise a booking right after it could be missed. A window wholly outside
  // the rules (e.g. in year 9999 or year 1, where the range would be out of the database's reach)
  // fetches nothing.
  const bounds = bookingBounds({ now, timezone: shop.timezone, depositCents: service.depositCents, rules });
  const startsFrom = Math.max(from.getTime(), bounds.earliest.getTime());
  const startsTo = Math.min(to.getTime(), bounds.latest?.getTime() ?? Infinity);
  const [staffHours, busy] = await Promise.all([
    deps.catalog.getStaffHours(shop.slug),
    startsFrom < startsTo
      ? deps.catalog.getBusyIntervals(shop.slug, {
          start: new Date(startsFrom),
          end: new Date(startsTo + service.durationMin * MIN_MS),
        })
      : Promise.resolve([]),
  ]);
  return computeAvailability({
    timezone: shop.timezone,
    durationMin: service.durationMin,
    staffHours,
    // Read-only: a lapsed hold is skipped here and expired by the next write or read of it.
    busy: activeBusy(busy, now),
    from,
    to,
    now,
    limit: input.limit,
    depositCents: service.depositCents,
    rules,
  });
}

// ---- Booking ----

/** Longest customer_name accepted, after trimming. Matches the bookings.customer_name check. */
export const MAX_CUSTOMER_NAME = 80;
/** Longest agent label stored. Longer client names are cut. */
const MAX_AGENT_NAME = 80;
export const UNKNOWN_AGENT = "unknown agent";
/** How many nearby starts a slot_taken error offers in details.alternatives. */
export const MAX_ALTERNATIVES = 3;

/** The most a mandate cap may be, in cents ($1,000,000). */
export const MAX_MANDATE_CAP_CENTS = 100_000_000;
const MANDATE_FIELDS = ["priceCapCents", "depositCapCents", "window"] as const;
const MANDATE_NEXT =
  "Send mandate as { priceCapCents?, depositCapCents?, window?: { from, to } }: caps in whole US cents, " +
  "the window as RFC 3339 date-times with offsets (from before to). Leave out any limit the person didn't set.";

/**
 * Check a raw `mandate` (any JSON) and narrow it to a Mandate, or null when absent, null or empty.
 * A null field counts as absent. Unknown fields are refused rather than ignored, so a limit the
 * person set is never silently dropped. Window strings are kept as given.
 */
export function parseMandate(raw: unknown): Mandate | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidField("mandate", "mandate must be an object.", MANDATE_NEXT, raw);
  }
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).find((k) => !(MANDATE_FIELDS as readonly string[]).includes(k));
  if (unknown !== undefined) {
    throw invalidField(`mandate.${unknown}`, `mandate has an unknown field "${unknown}".`, MANDATE_NEXT, fields[unknown]);
  }
  const mandate: Mandate = {};
  for (const cap of ["priceCapCents", "depositCapCents"] as const) {
    const value = fields[cap];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MANDATE_CAP_CENTS) {
      throw invalidField(
        `mandate.${cap}`,
        `mandate.${cap} must be a whole number of cents from 0 to ${MAX_MANDATE_CAP_CENTS}.`,
        MANDATE_NEXT,
        value,
      );
    }
    mandate[cap] = value;
  }
  const window = fields.window;
  if (window !== undefined && window !== null) {
    const bad = (message: string, field = "mandate.window") => invalidField(field, message, MANDATE_NEXT, window);
    if (typeof window !== "object" || Array.isArray(window)) throw bad("mandate.window must be an object { from, to }.");
    const w = window as Record<string, unknown>;
    const extra = Object.keys(w).find((k) => k !== "from" && k !== "to");
    if (extra !== undefined) throw bad(`mandate.window has an unknown field "${extra}".`, `mandate.window.${extra}`);
    for (const end of ["from", "to"] as const) {
      if (typeof w[end] !== "string" || !parseRfc3339(w[end] as string)) {
        throw bad(`mandate.window.${end} must be an RFC 3339 date-time with an offset.`, `mandate.window.${end}`);
      }
    }
    const from = w.from as string;
    const to = w.to as string;
    if ((parseRfc3339(from) as Date).getTime() >= (parseRfc3339(to) as Date).getTime()) {
      throw bad("mandate.window.from must be before mandate.window.to.", "mandate.window.to");
    }
    mandate.window = { from, to };
  }
  return Object.keys(mandate).length > 0 ? mandate : null;
}

const CUSTOMER_PHONE_NEXT =
  'Send customer_phone as the person\'s mobile number with its country code, e.g. "+14015550123", or leave it out.';

/**
 * Check a raw `customer_phone` (any JSON) and return it as E.164, or null when absent, null or "". Spaces,
 * dashes, dots and parentheses are removed first; anything that still isn't E.164 is invalid_request.
 */
export function parseCustomerPhone(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const e164 = typeof raw === "string" ? normalizePhone(raw) : null;
  if (!e164) {
    throw invalidField(
      "customer_phone",
      "customer_phone must be a phone number in international format, starting with + and the country code.",
      CUSTOMER_PHONE_NEXT,
      raw,
    );
  }
  return e164;
}

/**
 * Check raw `book` tool arguments (any JSON) and narrow them to BookInput, in the same style as
 * parseGetAvailabilityArgs: missing fields and wrong JSON types become invalid_request errors.
 * customer_name is returned trimmed; mandate is checked by parseMandate and customer_phone by
 * parseCustomerPhone (returned as E.164); each is omitted from the result when there is none. A signed-in
 * agent's call has customer_name and customer_phone filled in before it gets here (bookArgsFor in
 * lib/server/identity/customer.ts), so customer_name is always required here.
 */
export function parseBookArgs(raw: unknown): ParsedBookInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { service_id, start, customer_name } = args;

  if (typeof service_id !== "string" || service_id.trim() === "") {
    throw invalidField(
      "service_id",
      "service_id is required and must be a non-empty string.",
      'Call list_services and pass one of its service ids, e.g. "haircut".',
      service_id,
    );
  }
  if (typeof start !== "string") {
    throw invalidField(
      "start",
      "start is required and must be an RFC 3339 date-time string.",
      "Call get_availability and pass one of the returned slot starts exactly, e.g. 2026-11-14T14:30:00-05:00.",
      start,
    );
  }
  const name = typeof customer_name === "string" ? customer_name.trim() : "";
  if (name.length < 1 || name.length > MAX_CUSTOMER_NAME) {
    throw invalidField(
      "customer_name",
      `customer_name is required and must be 1–${MAX_CUSTOMER_NAME} characters after trimming spaces.`,
      `Ask the user what name the booking should be under (at most ${MAX_CUSTOMER_NAME} characters), then retry with it as customer_name.`,
      customer_name,
    );
  }
  if (name.includes(NUL)) {
    throw invalidField(
      "customer_name",
      "customer_name can't contain the NUL character (U+0000).",
      "Send the name the booking should be under as plain text, without control characters.",
      customer_name,
    );
  }

  const mandate = parseMandate(args.mandate);
  const phone = parseCustomerPhone(args.customer_phone);
  return {
    service_id,
    start,
    customer_name: name,
    ...(mandate ? { mandate } : {}),
    ...(phone ? { customer_phone: phone } : {}),
  };
}

/** BookInput after parseBookArgs: customer_name is always there. */
export type ParsedBookInput = BookInput & { customer_name: string };

/**
 * What book() hands back: the contract's BookResult (with `texted`), plus the staff name, when the hold
 * lapses in the shop's zone (e.g. "Tue 10 Nov, 11:10 am EST") and whether this deployment collects deposits,
 * for the text summary.
 */
export type BookOutcome = BookResult & { staffName: string; holdDisplay?: string; depositsOn?: boolean };

/**
 * Hold `input.start` for `input.service_id` until the person approves it. Returns the booking in
 * awaiting_approval with booking.approval: the link to send the person, and when the hold lapses (10
 * minutes). Calling it twice for the same time gets slot_taken the second time (the no_overlap
 * constraint), so a retried call can't double-book; get_booking shows the hold and its link again.
 *
 * 1. Validate the input (invalid_request), the mandate included.
 * 2. Check the start against the shop's rules (engine checkStart): paused, too_soon
 *    (details.earliest), too_far (details.latest). These are decided before busy time is read, so a
 *    start far in the past or future never queries bookings.
 * 3. decide() the "book" action: the person's mandate (outside_mandate, details.field) and the hold's
 *    deadline (now + 10 minutes).
 * 4. Lazy expiry: expire the shop's lapsed holds around the start, just before inserting, so a stale
 *    hold never blocks this booking. Then check against hours, blocked time and bookings:
 *    outside_hours, or slot_taken (details.alternatives: up to 3 nearby free starts). The staff
 *    member comes from the check.
 * 5. Store it with a new approval token (and customer_phone, if given). If another booking got there first
 *    (SlotTakenError, i.e. the no_overlap constraint), read busy time again and, if another staff member is
 *    free at exactly this start, try once more with them. If that fails too, or nobody is free, fail with
 *    slot_taken; the database is the final word even when step 4 passed.
 * 6. Where texting is on and customer_phone was given, text the approval link to it (textApprovalLink).
 *    `texted` says whether that worked; a failed text doesn't fail the booking, which is stored by then.
 *
 * The owner is alerted when the booking is confirmed (lib/server/consent/approvals.ts, or
 * lib/server/deposits/deposits.ts once a deposit is paid) or the person declines, not here: a hold alone
 * is no news. A booking awaiting its deposit past pay_by is checked with Stripe in step 4 too
 * (syncDeposit), so an unpaid one never blocks this booking.
 * `agent` is who is booking: a confirmed PAP agent ({ name, clientId }, from lib/server/identity/agent.ts),
 * stored with its client_id so Booking.agent shows it as confirmed; or a self-reported label (the MCP client's
 * name, the web API's bookedBy), unconfirmed.
 * With `customer` (an agent signed in as that person, lib/server/identity/customer.ts) the booking belongs to
 * them (customer_id); the caller has already filled customer_name and customer_phone from them.
 * TODO(ring-2): require a mandate once agents sign in.
 */
export async function book(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: BookInput,
  agent: string | { name: string; clientId: string },
  customer: BookingCustomer | null = null,
): Promise<BookOutcome> {
  const args = parseBookArgs(input);
  const start = parseRfc3339(args.start);
  if (!start) {
    throw invalidField(
      "start",
      "start is not an RFC 3339 date-time with an offset.",
      "Call get_availability and pass one of the returned slot starts exactly, e.g. 2026-11-14T14:30:00-05:00.",
      args.start,
    );
  }

  const who = typeof agent === "string" ? { name: agent, clientId: null } : agent;
  return bookOnce(deps, shopSlug, args, start, { name: cleanAgentName(who.name), clientId: who.clientId }, customer);
}

/** The signed-in customer a booking belongs to. */
export type BookingCustomer = { id: string };

/** checkStart's refusals that come from the shop's rules alone, before hours and busy time count. */
const RULE_REFUSALS: ReadonlySet<RefusedStart["reason"]> = new Set(["paused", "too_soon", "too_far"]);

/** Steps 2 to 5 of book(): check the start and store the hold. */
async function bookOnce(
  deps: FrontDeskDeps,
  shopSlug: string,
  args: ParsedBookInput,
  start: Date,
  agent: { name: string; clientId: string | null },
  customer: BookingCustomer | null,
): Promise<BookOutcome> {
  const shop = await requireShop(deps, shopSlug);
  const [service, policies, staffHours] = await Promise.all([
    findService(
      deps,
      shop,
      args.service_id,
      (validIds) =>
        new FrontDeskError(
          "invalid_request",
          `No service with id "${args.service_id}" at ${shop.name}.`,
          "Call list_services to get valid service ids, then call get_availability for that service and book one of its starts.",
          { field: "service_id", value: args.service_id, valid_service_ids: validIds },
        ),
    ),
    policiesFor(deps, shopSlug),
    deps.catalog.getStaffHours(shopSlug),
  ]);

  const now = deps.clock.now();
  const end = new Date(start.getTime() + service.durationMin * MIN_MS);
  const rulesOnly: StartCheckInput = {
    timezone: shop.timezone,
    durationMin: service.durationMin,
    staffHours,
    busy: [],
    now,
    depositCents: service.depositCents,
    rules: bookingRules(policies),
  };
  const refused = (check: RefusedStart, engine: StartCheckInput) =>
    startRefused(check, { shop, service, policies, requested: args.start, start, engine });
  /** The engine input with busy time around `start`, read now, without lapsed holds. */
  const withBusy = async (): Promise<StartCheckInput> => ({
    ...rulesOnly,
    busy: activeBusy(await deps.catalog.getBusyIntervals(shop.slug, busyRange(service, start)), now),
  });

  // The rules first, with no busy time: paused, too_soon and too_far don't depend on it, and a start
  // far in the past or future (year 1, year 9999) would put the busy-time range out of the database's reach.
  const byRules = checkStart(rulesOnly, start);
  if (!byRules.ok && RULE_REFUSALS.has(byRules.reason)) throw refused(byRules, rulesOnly);

  // The person's mandate, and the hold's deadline.
  const held = decide(
    { priceCents: service.priceCents, depositCents: service.depositCents, start, end, mandate: args.mandate ?? null },
    { type: "book", actor: "agent" },
    now,
  );
  if (held instanceof FrontDeskError) throw held;

  // Lazy expiry, just before the insert: a lapsed hold must not block this booking (the no_overlap
  // constraint would still count it) nor hide an alternative. The nightly tidy-up (nightly.ts) expires
  // the ones nobody touches.
  await deps.store.expireStaleHolds(shop.slug, busyRange(service, start), now);
  // The same for a booking whose deposit time ran out, after asking Stripe whether it was paid.
  await syncLapsedDeposits(deps, shop.slug, busyRange(service, start), now);

  let engine = await withBusy();
  const check = checkStart(engine, start);
  if (!check.ok) throw refused(check, engine);

  // The link's secret, stored as it is: every booking response while the hold is on carries the link.
  const token = newApprovalToken();
  /** The stored booking, or null if another booking holds that staff member's time (SlotTakenError). */
  const create = async (staffId: string): Promise<Booking | null> => {
    try {
      return await deps.store.createBooking({
        shopSlug: shop.slug,
        serviceId: service.id,
        staffId,
        start,
        end,
        customerName: args.customer_name,
        agentName: agent.name,
        agentClientId: agent.clientId,
        depositCents: service.depositCents,
        approveBy: held.approveBy,
        approvalToken: token,
        mandate: args.mandate ?? null,
        customerId: customer?.id ?? null,
        customerPhone: args.customer_phone ?? null,
      });
    } catch (err) {
      if (err instanceof SlotTakenError) return null;
      throw err;
    }
  };

  let booking = await create(check.slot.staffId);
  if (!booking) {
    // Another booking won the race between the check and the insert. Read busy time again, now that
    // the winner is stored: another staff member may still be free at exactly this start, so try once
    // more with them. Otherwise offer starts around it, from that fresh busy time.
    engine = await withBusy();
    const recheck = checkStart(engine, start);
    if (recheck.ok) {
      booking = await create(recheck.slot.staffId);
      if (!booking) engine = await withBusy();
    }
    if (!booking) throw slotTaken(args.start, service.id, alternativesNear(engine, start));
  }

  const staffId = booking.staffId;
  const staffName = staffHours.find((s) => s.staffId === staffId)?.staffName ?? staffId;
  const holdDisplay = formatDisplay(DateTime.fromJSDate(held.approveBy, { zone: shop.timezone }));
  const stored = withApprovalOrigin(deps, booking);
  const texted = args.customer_phone ? await textApprovalLink(deps, shop, stored, args.customer_phone) : false;
  return { booking: stored, texted, staffName, holdDisplay, depositsOn: deps.payments !== null };
}

/**
 * Text the approval link of `booking` (just stored, awaiting approval) to `phone`, where texting is on:
 * "<agent> asked <shop> to book <service> on <time> for you. Approve or decline: <link>". Returns whether
 * the provider accepted it. Never throws: a failed text is logged (without the number), and the agent then
 * sends the link itself.
 */
async function textApprovalLink(deps: FrontDeskDeps, shop: Shop, booking: Booking, phone: string): Promise<boolean> {
  if (!deps.texter || !booking.approval) return false;
  const body = approvalLinkText({
    agentName: booking.agent.name,
    shopName: shop.name,
    serviceName: booking.serviceName,
    display: booking.display,
    url: booking.approval.url,
  });
  try {
    await deps.texter.send(phone, body);
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({ event: "booking.approval_text_failed", id: booking.id, shop: shop.slug, provider: deps.texter.provider, error: alertError(err) }),
    );
    return false;
  }
}

/**
 * syncDeposit for every booking of the shop in `range` that is awaiting its deposit past pay_by: paid ones
 * are confirmed, unpaid ones expire. Stripe failures are logged and leave the booking as it is.
 */
async function syncLapsedDeposits(deps: FrontDeskDeps, shopSlug: string, range: { start: Date; end: Date }, now: Date): Promise<void> {
  const lapsed = (await deps.store.listBookings(shopSlug, range)).filter(
    (b) => b.status === "awaiting_deposit" && b.deposit.payBy !== undefined && Date.parse(b.deposit.payBy) <= now.getTime(),
  );
  for (const b of lapsed) await syncDeposit(deps, b);
}

/**
 * The time that can matter for a booking at `start` or for an alternative near it: every slot
 * nearbySlots considers starts within 24 hours of `start` and runs up to the service's duration.
 */
function busyRange(service: Service, start: Date) {
  return {
    start: new Date(start.getTime() - DAY_MS),
    end: new Date(start.getTime() + service.durationMin * MIN_MS + DAY_MS),
  };
}

/** Longest Alert.error stored. */
const MAX_ALERT_ERROR = 500;

/** An error as Alert.error: its message, without NUL (Postgres text can't hold it), at most 500 characters. */
function alertError(err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).replaceAll(NUL, "").trim() || "Unknown error.";
  return message.length > MAX_ALERT_ERROR ? `${message.slice(0, MAX_ALERT_ERROR - 1)}…` : message;
}

/**
 * Tell the owner that `booking` was confirmed or cancelled, and record the alert (deps.store.recordAlert)
 * whatever happened to it. Call it after the change is committed; `booking` is the booking as stored.
 * Never throws and never changes the booking: a failed send is recorded as status "failed" with the error
 * (and logged), and if even recording fails, that is only logged. No retries. TODO(ring-2): a retry job.
 * Where texting is on (deps.texter) and the shop has an ownerMobile, the alert is also texted there and
 * recorded as a second alert, channel "text"; the email or log line goes out as before.
 *
 * Callers: approveBooking and declineBooking (lib/server/consent/approvals.ts), cancelBooking (agents).
 * The console link uses deps.baseUrl, the origin of the request being served.
 */
export async function alertOwner(
  deps: FrontDeskDeps,
  kind: AlertKind,
  booking: Booking,
  cancelledBy: "agent" | "customer" | null = null,
): Promise<void> {
  const logFailure = (event: string, err: unknown) =>
    console.error(JSON.stringify({ event, id: booking.id, shop: booking.shopSlug, kind, error: alertError(err) }));
  try {
    const [shop, policies, services] = await Promise.all([
      deps.catalog.getShop(booking.shopSlug),
      policiesFor(deps, booking.shopSlug),
      deps.catalog.listServices(booking.shopSlug),
    ]);
    const service = services.find((s) => s.id === booking.serviceId);
    if (!shop || !service) throw new Error(`Booking ${booking.id} has no shop or service: ${booking.shopSlug}/${booking.serviceId}.`);
    const alert: OwnerAlert = {
      kind,
      booking,
      shop,
      priceCents: service.priceCents,
      ownerEmail: policies.ownerEmail,
      cancelledBy,
      consoleUrl: `${deps.baseUrl}/console`,
    };
    const route = deps.notifier.route(alert);
    let status: AlertStatus = route.channel === "email" ? "sent" : "logged";
    let error: string | null = null;
    try {
      await deps.notifier.send(alert, route);
    } catch (err) {
      // Failing the request now would make the agent retry into slot_taken for a booking that exists.
      status = "failed";
      error = alertError(err);
      logFailure("booking.notify_failed", err);
    }
    await deps.store.recordAlert({
      shopSlug: booking.shopSlug,
      bookingId: booking.id,
      kind,
      channel: route.channel,
      recipient: route.recipient,
      status,
      error,
    });
    if (deps.texter && policies.ownerMobile) await textOwner(deps, deps.texter, alert, policies.ownerMobile);
  } catch (err) {
    logFailure("booking.alert_not_recorded", err);
  }
}

/** alertOwner's text to the owner's mobile, recorded as an alert with channel "text" whatever happened to it. */
async function textOwner(deps: FrontDeskDeps, texter: TextSender, alert: OwnerAlert, ownerMobile: string): Promise<void> {
  let status: AlertStatus = "sent";
  let error: string | null = null;
  try {
    await texter.send(ownerMobile, ownerAlertText(alert));
  } catch (err) {
    status = "failed";
    error = alertError(err);
    console.error(JSON.stringify({ event: "booking.notify_failed", id: alert.booking.id, shop: alert.shop.slug, kind: alert.kind, channel: "text", error }));
  }
  await deps.store.recordAlert({
    shopSlug: alert.booking.shopSlug,
    bookingId: alert.booking.id,
    kind: alert.kind,
    channel: "text",
    recipient: ownerMobile,
    status,
    error,
  });
}

type RefusedStart = Exclude<StartCheck, { ok: true }>;

/** The FrontDeskError for a start checkStart refused, with the most specific code. */
function startRefused(
  check: RefusedStart,
  ctx: { shop: Shop; service: Service; policies: Policies; requested: string; start: Date; engine: StartCheckInput },
): FrontDeskError {
  const { shop, service, policies, requested, start, engine } = ctx;
  switch (check.reason) {
    case "paused": {
      const phone = shopPhone(policies);
      return new FrontDeskError(
        "paused",
        `${shop.name} isn't taking bookings right now.`,
        `Tell the person to call the shop${phone ? ` at ${phone}` : ""}.`,
        { phone },
      );
    }
    case "too_soon": {
      const display = formatDisplay(DateTime.fromJSDate(check.earliest, { zone: shop.timezone }));
      const message =
        policies.leadTimeMin > 0
          ? `${shop.name} needs at least ${minutesInWords(policies.leadTimeMin)} notice; the earliest start is ${display}.`
          : `That time has already passed; the earliest start at ${shop.name} is ${display}.`;
      return new FrontDeskError("too_soon", message, "Pick a later time: call get_availability from details.earliest.", {
        earliest: toRfc3339(check.earliest, shop.timezone),
        lead_time_min: policies.leadTimeMin,
        start: requested,
      });
    }
    case "too_far": {
      const days = service.depositCents > 0 ? policies.depositHorizonDays : policies.horizonDays;
      return new FrontDeskError(
        "too_far",
        `${shop.name} takes bookings for ${service.name} up to ${pluralize(days, "day")} ahead.`,
        "Pick an earlier time, before details.latest.",
        { latest: toRfc3339(check.latest, shop.timezone), horizon_days: days, start: requested },
      );
    }
    case "outside_hours":
      return new FrontDeskError(
        "outside_hours",
        `That isn't a bookable time for ${service.name}.`,
        "Call get_availability and choose one of the returned starts.",
        { field: "start", value: requested, service_id: service.id },
      );
    case "taken":
      return slotTaken(requested, service.id, alternativesNear(engine, start));
  }
}

const SLOT_TAKEN_NEXT = "Someone just took that time. Call get_availability again and choose another start.";

function slotTaken(start: string, serviceId: string, alternatives: Slot[]): FrontDeskError {
  return new FrontDeskError(
    "slot_taken",
    "That time is already booked.",
    alternatives.length > 0
      ? `${SLOT_TAKEN_NEXT} Nearby open starts you can offer instead are in details.alternatives.`
      : SLOT_TAKEN_NEXT,
    { start, service_id: serviceId, alternatives },
  );
}

/**
 * Up to MAX_ALTERNATIVES free starts closest to `start`, one Slot per distinct start, earliest first.
 * `start` itself is one of them only while some staff member is still free then (e.g. after a lost
 * race, when the retry with another staff member lost too and a third is free). nearbySlots returns
 * one Slot per free staff member and book picks the staff member itself, so ask it for enough Slots
 * to be sure of MAX_ALTERNATIVES distinct starts and keep the first Slot (lowest staffId) per start.
 */
function alternativesNear(engine: StartCheckInput, start: Date): Slot[] {
  const startMs = start.getTime();
  const perStart = Math.max(1, engine.staffHours.length);
  const distinct = new Map<number, Slot>();
  for (const slot of nearbySlots(engine, start, MAX_ALTERNATIVES * perStart)) {
    const ms = Date.parse(slot.start);
    if (!distinct.has(ms)) distinct.set(ms, slot);
  }
  return [...distinct]
    .sort(([a], [b]) => Math.abs(a - startMs) - Math.abs(b - startMs) || a - b)
    .slice(0, MAX_ALTERNATIVES)
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => slot);
}

/** C0 control characters, U+0000–U+001F: no use in a label, and Postgres text can't hold U+0000. */
const CONTROL_CHARACTERS = /[\u0000-\u001F]/g;

/** The agent's name as stored: control characters removed, trimmed, at most 80 characters. */
function cleanAgentName(name: string): string {
  const trimmed = name.replace(CONTROL_CHARACTERS, "").trim().slice(0, MAX_AGENT_NAME);
  return trimmed === "" ? UNKNOWN_AGENT : trimmed;
}

// ---- Reading and cancelling a booking (agents) ----

function parseBookingId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidField(
      "booking_id",
      "booking_id is required and must be a non-empty string.",
      "Pass the booking.id (a UUID) that book returned.",
      value,
    );
  }
  return value.trim();
}

/** Check raw `get_booking` arguments (any JSON) and narrow them to GetBookingInput. booking_id is returned trimmed. */
export function parseGetBookingArgs(raw: unknown): GetBookingInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { booking_id: parseBookingId(args.booking_id) };
}

/** What getBooking() hands back: the contract's GetBookingResult, plus whether the person declined (for the text). */
export type GetBookingOutcome = GetBookingResult & { declined: boolean };

/**
 * One booking at the shop, after lazy expiry (a lapsed hold reads as expired). An unknown, malformed
 * or other shop's id is booking_not_found. While the hold is on it includes booking.approval, the same
 * link book returned.
 * TODO(ring-2): get_booking and cancel still trust anyone holding the booking id; agent identity fixes this.
 */
export async function getBooking(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: GetBookingInput,
): Promise<GetBookingOutcome> {
  const { booking_id } = parseGetBookingArgs(input);
  await requireShop(deps, shopSlug);
  const booking = await requireBooking(deps, shopSlug, booking_id);
  const declined =
    booking.status === "cancelled" && (await deps.store.listEvents(booking.id)).some((e) => e.type === "declined");
  return { booking: withApprovalOrigin(deps, booking), declined };
}

/** Check raw `cancel` arguments (any JSON) and narrow them to CancelInput. booking_id is returned trimmed. */
export function parseCancelArgs(raw: unknown): CancelInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { booking_id: parseBookingId(args.booking_id) };
}

/**
 * An agent cancels a booking, under the shop's policy (decide(): a hold awaiting approval or a booking
 * awaiting its deposit → cancelled any time; confirmed at least cancelWindowHours ahead → deposit
 * released; later but before the start → captured; after the start or from a final status, a lapsed
 * hold included → not_cancellable). The deposit then moves in Stripe (transitionBooking). A second cancel
 * of the same booking is not_cancellable (it's already cancelled), so a retry is harmless.
 * Once it's cancelled, the owner is alerted (booking_cancelled): a cancel only succeeds from a status that
 * holds the time, so that's a confirmed booking, a hold awaiting approval or one awaiting its deposit. The
 * owner's own cancel (owner.ts) sends no alert.
 * TODO(ring-2): get_booking and cancel still trust anyone holding the booking id; agent identity fixes this.
 */
export async function cancelBooking(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: CancelInput,
): Promise<CancelResult> {
  const args = parseCancelArgs(input);
  const result = await transitionBooking(deps, shopSlug, args.booking_id, "cancel", "agent");
  await alertOwner(deps, "booking_cancelled", result.booking, "agent");
  return result;
}

// ---- Bookings list (UI) ----

/** The bookings window the UI sees: this far back and ahead of now. */
export const BOOKINGS_PAST_DAYS = 7;
export const BOOKINGS_FUTURE_DAYS = 30;

/**
 * The shop and its bookings of any status from 7 days ago to 30 days ahead, sorted by start. Lapsed
 * holds in that range are expired first (lazy expiry), and each booking awaiting its deposit is checked
 * with Stripe (syncDeposit), so the list never shows a stale one. A booking awaiting approval (or its
 * deposit) includes its approval link, for the owner to copy; booking.deposit.actionFailed shows a capture
 * or release Stripe refused. An owner route (it shows customers' phone numbers): the HTTP layer checks
 * owner auth first.
 */
export async function listShopBookings(deps: FrontDeskDeps, shopSlug: string): Promise<BookingsResponse> {
  const shop = await requireShop(deps, shopSlug);
  const now = deps.clock.now();
  const range = {
    start: new Date(now.getTime() - BOOKINGS_PAST_DAYS * DAY_MS),
    end: new Date(now.getTime() + BOOKINGS_FUTURE_DAYS * DAY_MS),
  };
  await deps.store.expireStaleHolds(shopSlug, range, now);
  const listed = await deps.store.listBookings(shopSlug, range);
  const bookings = await Promise.all(listed.map((b) => syncDeposit(deps, b)));
  return { shop, bookings: bookings.map((b) => withApprovalOrigin(deps, b)) };
}
