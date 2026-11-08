import { DateTime } from "luxon";
import type {
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
import type { CodeSender } from "../consent/code-sender";
import { approvalUrl, type ConsentConfig } from "../consent/config";
import { newApprovalToken, sha256Hex } from "../consent/crypto";
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
import type { Notifier } from "../notify/notifier";
import { SlotTakenError, type BookingStore } from "./booking-store";
import type { BusyInterval, ShopCatalog } from "./catalog";
import { FrontDeskError } from "./errors";
import { parseIdempotencyKey, requestHash } from "./idempotency";
import { normalizeUuid } from "./idempotency-errors";
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
  /** Approval links and dev codes (Ring 1b). */
  consent: ConsentConfig;
  /** Delivers one-time codes to phones (Ring 1b: a log line). */
  codeSender: CodeSender;
};

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
    "Check the booking id. It is the booking.id (a UUID) that book returned.",
    { booking_id: bookingId },
  );
}

/**
 * The booking if it exists and belongs to `shopSlug`; otherwise booking_not_found. Reading it expires
 * its hold first if that lapsed (store.refreshBooking), so a caller never sees a stale hold.
 */
export async function requireBooking(deps: FrontDeskDeps, shopSlug: string, bookingId: string): Promise<Booking> {
  const booking = await deps.store.refreshBooking(bookingId, deps.clock.now());
  if (!booking || booking.shopSlug !== shopSlug) throw bookingNotFound(bookingId);
  return booking;
}

export const EVENT_FOR: Record<LifecycleAction, BookingEventType> = {
  cancel: "cancelled",
  complete: "completed",
  mark_no_show: "no_show",
  approve: "approved",
  decline: "declined",
  expire: "expired",
};

/** How many times transitionBooking re-reads and re-decides after losing a race. */
const MAX_TRANSITION_ATTEMPTS = 3;

/**
 * Apply an agent's or owner's lifecycle action (cancel, complete, mark_no_show) to a booking: expire a
 * lapsed hold first (requireBooking), decide() against the shop's policies and the clock, then
 * store.transition() conditionally on the status it decided from, writing one event.
 * If another transition got there first (transition returns null), re-read the booking and decide
 * again, so the loser gets the right error (e.g. not_cancellable) instead of a stale success.
 * Throws not_found (shop), booking_not_found, or decide()'s FrontDeskError.
 * TODO(ring-1c): move real money. depositEffect is what the policy decides; nothing is collected.
 */
export async function transitionBooking(
  deps: FrontDeskDeps,
  shopSlug: string,
  bookingId: string,
  action: ManageAction,
  actor: "agent" | "owner",
): Promise<BookingTransitionResult> {
  await requireShop(deps, shopSlug);
  const policies = await policiesFor(deps, shopSlug);
  for (let attempt = 1; attempt <= MAX_TRANSITION_ATTEMPTS; attempt++) {
    const booking = await requireBooking(deps, shopSlug, bookingId);
    const decision = decide(booking, { type: action, actor }, deps.clock.now(), policies);
    if (decision instanceof FrontDeskError) throw decision;
    const updated = await deps.store.transition(booking.id, booking.status, decision.nextStatus, {
      actor,
      type: EVENT_FOR[action],
      data: {
        from: booking.status,
        to: decision.nextStatus,
        depositEffect: decision.depositEffect,
        depositCollected: false,
      },
    });
    if (updated) return { booking: updated, depositEffect: decision.depositEffect, depositCollected: false };
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

/** The shop and its booking rules (lead time, horizons, cancellation window, pause, phone, rule texts). */
export async function getPolicies(deps: FrontDeskDeps, shopSlug: string): Promise<GetPoliciesResult> {
  const shop = await requireShop(deps, shopSlug);
  return { shop, policies: await policiesFor(deps, shopSlug) };
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

/** The mandate as a stable string for the idempotency hash: fixed key order, window ends as instants. */
function mandateFingerprint(m: Mandate): string {
  const instant = (v: string) => (parseRfc3339(v) as Date).toISOString();
  return JSON.stringify([
    m.priceCapCents ?? null,
    m.depositCapCents ?? null,
    m.window ? [instant(m.window.from), instant(m.window.to)] : null,
  ]);
}

/**
 * Check raw `book` tool arguments (any JSON) and narrow them to BookInput, in the same style as
 * parseGetAvailabilityArgs: missing fields and wrong JSON types become invalid_request errors.
 * customer_name is returned trimmed; idempotency_key is checked by parseIdempotencyKey; mandate by
 * parseMandate (omitted from the result when there is none).
 */
export function parseBookArgs(raw: unknown): BookInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { service_id, start, customer_name, idempotency_key } = args;

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
  return {
    service_id,
    start,
    customer_name: name,
    idempotency_key: parseIdempotencyKey(idempotency_key),
    ...(mandate ? { mandate } : {}),
  };
}

/**
 * What book() hands back: the contract's BookResult, plus the staff name and when the hold lapses in
 * the shop's zone (e.g. "Tue 10 Nov, 11:10 am EST"), for the text summary.
 */
export type BookOutcome = BookResult & { staffName: string; holdDisplay?: string };

/**
 * Hold `input.start` for `input.service_id` until the person approves it, at most once per
 * idempotency_key. Returns the booking in awaiting_approval with booking.approval: the link to send
 * the person, and when the hold lapses (10 minutes).
 *
 * 1. Validate the input (invalid_request), the mandate included.
 * 2. Hash the normalized request (shop, service, start as an instant, trimmed name, and the mandate
 *    when there is one) and run the rest inside store.idempotent: the same key with the same request
 *    returns the first call's result (replayed: true), the same approval link included, without
 *    booking again; the same key with another request is idempotency_conflict. A call that fails
 *    isn't remembered, so it can be retried with the same key. The saved result holds the link, since
 *    the token can't be recomputed from its stored hash.
 * 3. Check the start against the shop's rules (engine checkStart): paused, too_soon
 *    (details.earliest), too_far (details.latest). These are decided before busy time is read, so a
 *    start far in the past or future never queries bookings.
 * 4. decide() the "book" action: the person's mandate (outside_mandate, details.field) and the hold's
 *    deadline (now + 10 minutes).
 * 5. Lazy expiry: expire the shop's lapsed holds around the start, in the same transaction, so a
 *    stale hold never blocks this booking. Then check against hours, blocked time and bookings:
 *    outside_hours, or slot_taken (details.alternatives: up to 3 nearby free starts). The staff
 *    member comes from the check.
 * 6. Store it with a new approval token's hash, with the store the idempotent action receives (in
 *    Postgres, the key's transaction). If another booking got there first (SlotTakenError, i.e. the
 *    no_overlap constraint), read busy time again and, if another staff member is free at exactly this
 *    start, try once more with them. If that fails too, or nobody is free, fail with slot_taken; the
 *    database is the final word even when step 5 passed.
 *
 * The owner is alerted when the person approves (lib/server/consent/approvals.ts), not here.
 *
 * TODO(ring-1c): deposits. Approval confirms the booking; awaiting_deposit and collecting the deposit
 * come with Stripe. Booking.depositCents shows what the service requires; nothing is collected.
 * TODO(ring-2): require a mandate once agents sign in.
 */
export async function book(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: BookInput,
  agentName: string,
): Promise<BookOutcome & { replayed: boolean }> {
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

  const scope = {
    key: args.idempotency_key,
    tool: "book" as const,
    // The instant, not the string: the same time written with another offset is the same request.
    // The mandate counts only when there is one, so a request without it hashes as it did in Ring 1a.
    requestHash: requestHash({
      shop: shopSlug,
      service_id: args.service_id,
      start: start.toISOString(),
      customer_name: args.customer_name,
      ...(args.mandate ? { mandate: mandateFingerprint(args.mandate) } : {}),
    }),
  };
  // The action reads and writes through the store it's given (in Postgres, the key's transaction).
  const { result, replayed } = await deps.store.idempotent(scope, (tx) =>
    bookOnce({ ...deps, catalog: tx, store: tx }, shopSlug, args, start, cleanAgentName(agentName)),
  );
  return { ...result, replayed };
}

/** checkStart's refusals that come from the shop's rules alone, before hours and busy time count. */
const RULE_REFUSALS: ReadonlySet<RefusedStart["reason"]> = new Set(["paused", "too_soon", "too_far"]);

/** Steps 3 to 6 of book(): check the start and store the hold. `deps.catalog` and `deps.store` are the idempotent action's store. */
async function bookOnce(
  deps: FrontDeskDeps,
  shopSlug: string,
  args: BookInput,
  start: Date,
  agentName: string,
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

  // Lazy expiry, in this transaction: a lapsed hold must not block this booking (the no_overlap
  // constraint would still count it) nor hide an alternative. TODO(ring-2): a scheduled job too.
  await deps.store.expireStaleHolds(shop.slug, busyRange(service, start), now);

  let engine = await withBusy();
  const check = checkStart(engine, start);
  if (!check.ok) throw refused(check, engine);

  // The link's secret. Only its hash is stored; the link itself is returned once (and kept in the
  // idempotency key's saved result for replays).
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
        agentName,
        depositCents: service.depositCents,
        approveBy: held.approveBy,
        approvalTokenHash: sha256Hex(token),
        mandate: args.mandate ?? null,
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
  const approval = { url: approvalUrl(deps.consent, token), expiresAt: toRfc3339(held.approveBy, shop.timezone) };
  const holdDisplay = formatDisplay(DateTime.fromJSDate(held.approveBy, { zone: shop.timezone }));
  return { booking: { ...booking, approval }, staffName, holdDisplay };
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

/**
 * Tell the owner about a booking the person just approved. It's already stored, so a failure is only
 * logged. Called by the approve use case (lib/server/consent/approvals.ts), once per booking.
 */
export async function alertOwner(notifier: Notifier, booking: Booking): Promise<void> {
  try {
    await notifier.alertOwner(booking);
  } catch (err) {
    // Failing now would make the agent retry into slot_taken (or a replay) for a booking that exists.
    console.error(
      JSON.stringify({
        event: "booking.notify_failed",
        id: booking.id,
        shop: booking.shopSlug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
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

/** The MCP client's self-reported name as stored: control characters removed, trimmed, at most 80 characters. */
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
 * or other shop's id is booking_not_found. It never includes booking.approval (see Booking.approval).
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
  return { booking, declined };
}

/** Check raw `cancel` arguments (any JSON) and narrow them to CancelInput. booking_id is returned trimmed. */
export function parseCancelArgs(raw: unknown): CancelInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    booking_id: parseBookingId(args.booking_id),
    idempotency_key: parseIdempotencyKey(args.idempotency_key),
  };
}

/**
 * An agent cancels a booking, under the shop's policy (decide(): a hold awaiting approval → cancelled
 * any time; confirmed at least cancelWindowHours ahead → deposit released; later but before the start
 * → captured; after the start or from a final status, a lapsed hold included → not_cancellable). At
 * most once per idempotency_key: the same key for the same booking returns the first result
 * (replayed: true) without a second event; the same key for another booking is idempotency_conflict.
 * A call that fails isn't remembered.
 * TODO(ring-2): get_booking and cancel still trust anyone holding the booking id; agent identity fixes this.
 * TODO(ring-1c): alert the owner when an agent cancels (the Notifier only knows new bookings).
 */
export async function cancelBooking(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: CancelInput,
): Promise<CancelResult & { replayed: boolean }> {
  const args = parseCancelArgs(input);
  const scope = {
    key: args.idempotency_key,
    tool: "cancel" as const,
    // A UUID in either case is the same booking, so the same request.
    requestHash: requestHash({ shop: shopSlug, booking_id: normalizeUuid(args.booking_id) ?? args.booking_id }),
  };
  const { result, replayed } = await deps.store.idempotent(scope, (tx) =>
    transitionBooking({ ...deps, catalog: tx, store: tx }, shopSlug, args.booking_id, "cancel", "agent"),
  );
  return { ...result, replayed };
}

// ---- Bookings list (UI) ----

/** The bookings window the UI sees: this far back and ahead of now. */
export const BOOKINGS_PAST_DAYS = 7;
export const BOOKINGS_FUTURE_DAYS = 30;

/**
 * The shop and its bookings of any status from 7 days ago to 30 days ahead, sorted by start. Lapsed
 * holds in that range are expired first (lazy expiry), so the list never shows a stale hold. Bookings
 * never include their approval link.
 *
 * TODO(ring-2): owner sign-in. Until then anyone with the URL can read customer names.
 */
export async function listShopBookings(deps: FrontDeskDeps, shopSlug: string): Promise<BookingsResponse> {
  const shop = await requireShop(deps, shopSlug);
  const now = deps.clock.now();
  const range = {
    start: new Date(now.getTime() - BOOKINGS_PAST_DAYS * DAY_MS),
    end: new Date(now.getTime() + BOOKINGS_FUTURE_DAYS * DAY_MS),
  };
  await deps.store.expireStaleHolds(shopSlug, range, now);
  const bookings = await deps.store.listBookings(shopSlug, range);
  return { shop, bookings };
}
