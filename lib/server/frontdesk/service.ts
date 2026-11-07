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
  Policies,
  Service,
  Shop,
  Slot,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import {
  checkStart,
  computeAvailability,
  formatDisplay,
  nearbySlots,
  validateRequest,
  type BookingRules,
  type StartCheck,
  type StartCheckInput,
} from "../engine/availability";
import { decide, type LifecycleAction, type LifecycleActor } from "../engine/lifecycle";
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
// Production wiring lives in deps.ts.

export type FrontDeskDeps = {
  catalog: ShopCatalog;
  clock: Clock;
  store: BookingStore;
  notifier: Notifier;
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

/** The shop, or a not_found FrontDeskError. */
export async function requireShop(deps: FrontDeskDeps, shopSlug: string): Promise<Shop> {
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

/** The booking if it exists and belongs to `shopSlug`; otherwise booking_not_found. */
export async function requireBooking(deps: FrontDeskDeps, shopSlug: string, bookingId: string): Promise<Booking> {
  const booking = await deps.store.getBooking(bookingId);
  if (!booking || booking.shopSlug !== shopSlug) throw bookingNotFound(bookingId);
  return booking;
}

const EVENT_FOR: Record<LifecycleAction, BookingEventType> = {
  cancel: "cancelled",
  complete: "completed",
  mark_no_show: "no_show",
};

/** How many times transitionBooking re-reads and re-decides after losing a race. */
const MAX_TRANSITION_ATTEMPTS = 3;

/**
 * Apply a lifecycle action to a booking: decide() against the shop's policies and the clock, then
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
  action: LifecycleAction,
  actor: LifecycleActor,
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

  // A slot may start just before `to` and run past it, so fetch busy time up to
  // to + duration; otherwise a booking right after the window could be missed.
  const busyUntil = new Date(to.getTime() + service.durationMin * MIN_MS);
  const [staffHours, busy] = await Promise.all([
    deps.catalog.getStaffHours(shop.slug),
    deps.catalog.getBusyIntervals(shop.slug, { start: from, end: busyUntil }),
  ]);
  return computeAvailability({
    timezone: shop.timezone,
    durationMin: service.durationMin,
    staffHours,
    busy,
    from,
    to,
    now: deps.clock.now(),
    limit: input.limit,
    depositCents: service.depositCents,
    rules: bookingRules(policies),
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

/**
 * Check raw `book` tool arguments (any JSON) and narrow them to BookInput, in the same style as
 * parseGetAvailabilityArgs: missing fields and wrong JSON types become invalid_request errors.
 * customer_name is returned trimmed; idempotency_key is checked by parseIdempotencyKey.
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

  return { service_id, start, customer_name: name, idempotency_key: parseIdempotencyKey(idempotency_key) };
}

/** What book() hands back: the contract's BookResult, plus the staff name for the text summary. */
export type BookOutcome = BookResult & { staffName: string };

/**
 * Book `input.start` for `input.service_id`, immediately and confirmed, at most once per
 * idempotency_key.
 *
 * 1. Validate the input (invalid_request).
 * 2. Hash the normalized request (shop, service, start as an instant, trimmed name) and run the rest
 *    inside store.idempotent: the same key with the same request returns the first call's booking
 *    (replayed: true) without booking again; the same key with another request is
 *    idempotency_conflict. A call that fails isn't remembered, so it can be retried with the same key.
 * 3. Check the start against the shop's rules, hours, blocked time and bookings (engine checkStart):
 *    paused, too_soon (details.earliest), too_far (details.latest), outside_hours, or slot_taken
 *    (details.alternatives: up to 3 nearby free starts). The staff member comes from the check.
 * 4. Store it with the store the idempotent action receives (in Postgres, the key's transaction).
 *    If another booking got there first (SlotTakenError, i.e. the no_overlap constraint), fail with
 *    slot_taken; the database is the final word even when step 3 passed.
 * 5. Alert the owner, only for a new booking (not a replay). A failing notifier is logged and never
 *    fails the booking.
 *
 * TODO(ring-1c): deposits. book creates confirmed bookings; awaiting_deposit and collecting the
 * deposit come with Stripe. Booking.depositCents shows what the service requires; nothing is collected.
 * TODO(ring-1b): verified customer identity, consent and mandate. customer.verified is always false.
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
    requestHash: requestHash({
      shop: shopSlug,
      service_id: args.service_id,
      start: start.toISOString(),
      customer_name: args.customer_name,
    }),
  };
  const { result, replayed } = await deps.store.idempotent(scope, (store) =>
    bookOnce({ ...deps, store }, shopSlug, args, start, cleanAgentName(agentName)),
  );

  if (!replayed) await alertOwner(deps.notifier, result.booking);
  return { ...result, replayed };
}

/** Steps 3 and 4 of book(): check the start and store the booking. `deps.store` is the idempotent action's store. */
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

  const engine: StartCheckInput = {
    timezone: shop.timezone,
    durationMin: service.durationMin,
    staffHours,
    busy: await busyAround(deps, shop, service, start),
    now: deps.clock.now(),
    depositCents: service.depositCents,
    rules: bookingRules(policies),
  };
  const check = checkStart(engine, start);
  if (!check.ok) throw startRefused(check, { shop, service, policies, requested: args.start, start, engine });

  let booking;
  try {
    booking = await deps.store.createBooking({
      shopSlug: shop.slug,
      serviceId: service.id,
      staffId: check.slot.staffId,
      start,
      end: new Date(start.getTime() + service.durationMin * MIN_MS),
      customerName: args.customer_name,
      agentName,
      depositCents: service.depositCents,
    });
  } catch (err) {
    // Another booking won the race between the check and the insert. Offer starts around it,
    // from busy time read again now that the winner is stored.
    if (!(err instanceof SlotTakenError)) throw err;
    const fresh = { ...engine, busy: await busyAround(deps, shop, service, start) };
    throw slotTaken(args.start, service.id, alternativesNear(fresh, start));
  }

  const staffName = staffHours.find((s) => s.staffId === check.slot.staffId)?.staffName ?? check.slot.staffId;
  return { booking, staffName };
}

/**
 * Busy time that can matter for a booking at `start` or for an alternative near it: every slot
 * nearbySlots considers starts within 24 hours of `start` and runs up to the service's duration.
 */
function busyAround(deps: FrontDeskDeps, shop: Shop, service: Service, start: Date): Promise<BusyInterval[]> {
  return deps.catalog.getBusyIntervals(shop.slug, {
    start: new Date(start.getTime() - DAY_MS),
    end: new Date(start.getTime() + service.durationMin * MIN_MS + DAY_MS),
  });
}

/** Tell the owner about a new booking. It's already stored, so a failure is only logged. */
async function alertOwner(notifier: Notifier, booking: Booking): Promise<void> {
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
 * Up to MAX_ALTERNATIVES free starts closest to `start` (not `start` itself), one Slot per distinct
 * start, earliest first. nearbySlots returns one Slot per free staff member and book picks the staff
 * member itself, so ask it for enough Slots to be sure of MAX_ALTERNATIVES + 1 distinct starts, keep
 * the first Slot (lowest staffId) per start, and drop the refused one.
 */
function alternativesNear(engine: StartCheckInput, start: Date): Slot[] {
  const startMs = start.getTime();
  const perStart = Math.max(1, engine.staffHours.length);
  const distinct = new Map<number, Slot>();
  for (const slot of nearbySlots(engine, start, (MAX_ALTERNATIVES + 1) * perStart)) {
    const ms = Date.parse(slot.start);
    if (ms !== startMs && !distinct.has(ms)) distinct.set(ms, slot);
  }
  return [...distinct]
    .sort(([a], [b]) => Math.abs(a - startMs) - Math.abs(b - startMs) || a - b)
    .slice(0, MAX_ALTERNATIVES)
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => slot);
}

function cleanAgentName(name: string): string {
  const trimmed = name.trim().slice(0, MAX_AGENT_NAME);
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

/**
 * One booking at the shop. An unknown, malformed or other shop's id is booking_not_found.
 * TODO(ring-1b): anyone holding a booking id can read or cancel it until customer consent ships.
 */
export async function getBooking(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: GetBookingInput,
): Promise<GetBookingResult> {
  const { booking_id } = parseGetBookingArgs(input);
  await requireShop(deps, shopSlug);
  return { booking: await requireBooking(deps, shopSlug, booking_id) };
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
 * An agent cancels a booking, under the shop's policy (decide(): cancelled at least
 * cancelWindowHours ahead → deposit released; later but before the start → captured; after the start
 * or from a final status → not_cancellable). At most once per idempotency_key: the same key for the
 * same booking returns the first result (replayed: true) without a second event; the same key for
 * another booking is idempotency_conflict. A call that fails isn't remembered.
 * TODO(ring-1b): anyone holding a booking id can read or cancel it until customer consent ships.
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
  const { result, replayed } = await deps.store.idempotent(scope, (store) =>
    transitionBooking({ ...deps, store }, shopSlug, args.booking_id, "cancel", "agent"),
  );
  return { ...result, replayed };
}

// ---- Bookings list (UI) ----

/** The bookings window the UI sees: this far back and ahead of now. */
export const BOOKINGS_PAST_DAYS = 7;
export const BOOKINGS_FUTURE_DAYS = 30;

/**
 * The shop and its bookings of any status from 7 days ago to 30 days ahead, sorted by start.
 *
 * TODO(ring-2): owner sign-in. Until then anyone with the URL can read customer names.
 */
export async function listShopBookings(deps: FrontDeskDeps, shopSlug: string): Promise<BookingsResponse> {
  const shop = await requireShop(deps, shopSlug);
  const now = deps.clock.now().getTime();
  const bookings = await deps.store.listBookings(shopSlug, {
    start: new Date(now - BOOKINGS_PAST_DAYS * DAY_MS),
    end: new Date(now + BOOKINGS_FUTURE_DAYS * DAY_MS),
  });
  return { shop, bookings };
}
