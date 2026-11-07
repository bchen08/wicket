import type {
  BookInput,
  Booking,
  BookingEventType,
  BookingsResponse,
  BookingTransitionResult,
  BookResult,
  GetAvailabilityInput,
  GetAvailabilityResult,
  ListServicesResult,
  Policies,
  Service,
  Shop,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import {
  computeAvailability,
  MAX_LIMIT,
  validateRequest,
  type AvailabilityInput,
} from "../engine/availability";
import { decide, type LifecycleAction, type LifecycleActor } from "../engine/lifecycle";
import type { Notifier } from "../notify/notifier";
import { SlotTakenError, type BookingStore } from "./booking-store";
import type { ShopCatalog } from "./catalog";
import { FrontDeskError } from "./errors";
import { DEFAULT_POLICIES } from "./policies";
import { parseRfc3339 } from "./time";

// Transport-agnostic use cases behind the MCP tools and the UI routes. They take their
// dependencies as arguments so tests can pass a fixed clock and the in-memory store.
// Production wiring lives in deps.ts.

export type FrontDeskDeps = {
  catalog: ShopCatalog;
  clock: Clock;
  store: BookingStore;
  notifier: Notifier;
};

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
 * TODO(ring-1b): anyone holding a booking id can cancel it until customer consent ships.
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
  const shop = await deps.catalog.getShop(shopSlug);
  if (!shop) throw shopNotFound(shopSlug);
  const services = await deps.catalog.listServices(shopSlug);
  return { shop, services };
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

/** Bookable start times for one service in a window. */
export async function getAvailability(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: GetAvailabilityInput,
): Promise<GetAvailabilityResult> {
  const from = parseInstant("from", input.from);
  const to = parseInstant("to", input.to);
  // Reject a bad window before asking the catalog for anything.
  validateRequest({ from, to, limit: input.limit });

  const shop = await deps.catalog.getShop(shopSlug);
  if (!shop) throw shopNotFound(shopSlug);

  const services = await deps.catalog.listServices(shopSlug);
  const service = services.find((s) => s.id === input.service_id);
  if (!service) {
    throw new FrontDeskError(
      "not_found",
      `No service with id "${input.service_id}" at ${shop.name}.`,
      "Call list_services to get valid service ids, then retry with one of them.",
      { service_id: input.service_id, valid_service_ids: services.map((s) => s.id) },
    );
  }

  const { result } = await findSlots(deps, shop, service, { from, to, limit: input.limit });
  return result;
}

/** Run the engine for one service over [from, to). Also returns the staff hours it used. */
async function findSlots(
  deps: FrontDeskDeps,
  shop: Shop,
  service: Service,
  window: { from: Date; to: Date; limit?: number },
) {
  const { from, to, limit } = window;
  // A slot may start just before `to` and run past it, so fetch busy time up to
  // to + duration; otherwise a booking right after the window could be missed.
  const busyUntil = new Date(to.getTime() + service.durationMin * 60_000);
  const [staffHours, busy] = await Promise.all([
    deps.catalog.getStaffHours(shop.slug),
    deps.catalog.getBusyIntervals(shop.slug, { start: from, end: busyUntil }),
  ]);

  const input: AvailabilityInput = {
    timezone: shop.timezone,
    durationMin: service.durationMin,
    staffHours,
    busy,
    from,
    to,
    now: deps.clock.now(),
    limit,
  };
  return { result: computeAvailability(input), staffHours, input };
}

// ---- Booking ----

/** Longest customer_name accepted, after trimming. Matches the bookings.customer_name check. */
export const MAX_CUSTOMER_NAME = 80;
/** Longest agent label stored. Longer client names are cut. */
const MAX_AGENT_NAME = 80;
export const UNKNOWN_AGENT = "unknown agent";

/**
 * Check raw `book` tool arguments (any JSON) and narrow them to BookInput, in the same style as
 * parseGetAvailabilityArgs: missing fields and wrong JSON types become invalid_request errors.
 * customer_name is returned trimmed.
 */
export function parseBookArgs(raw: unknown): BookInput {
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

  return { service_id, start, customer_name: name };
}

/** What book() hands back: the contract's BookResult, plus the staff name for the text summary. */
export type BookOutcome = BookResult & { staffName: string };

/**
 * Book `input.start` for `input.service_id`, immediately and confirmed.
 *
 * 1. Validate the input.
 * 2. Recompute availability over [start, start + duration) with the current clock and require
 *    `start` to be one of the returned slots. The staff member comes from the matching slot.
 *    Off-grid, out-of-hours and past starts are invalid_request. A start that is only blocked by
 *    an existing booking is slot_taken, so booking the same slot twice says "taken" either way.
 * 3. Store it. If another booking got there first (SlotTakenError, i.e. the database's
 *    no_overlap constraint), fail with slot_taken. The database is the final word even when
 *    step 2 passed.
 * 4. Alert the owner. A failing notifier is logged and never fails the booking.
 *
 * TODO(ring-1): deposits. Booking.depositCents shows what the service requires; nothing is collected.
 * TODO(ring-1): idempotency keys, so an agent can safely retry a book call that timed out.
 * TODO(ring-2): verified customer identity. customer.verified is always false.
 */
export async function book(
  deps: FrontDeskDeps,
  shopSlug: string,
  input: BookInput,
  agentName: string,
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

  const shop = await deps.catalog.getShop(shopSlug);
  if (!shop) throw shopNotFound(shopSlug);

  const services = await deps.catalog.listServices(shopSlug);
  const service = services.find((s) => s.id === args.service_id);
  if (!service) {
    throw new FrontDeskError(
      "invalid_request",
      `No service with id "${args.service_id}" at ${shop.name}.`,
      "Call list_services to get valid service ids, then call get_availability for that service and book one of its starts.",
      { field: "service_id", value: args.service_id, valid_service_ids: services.map((s) => s.id) },
    );
  }

  const end = new Date(start.getTime() + service.durationMin * 60_000);
  const { result, staffHours, input: engineInput } = await findSlots(deps, shop, service, {
    from: start,
    to: end,
    limit: MAX_LIMIT,
  });
  const isStart = (s: { start: string }) => parseRfc3339(s.start)?.getTime() === start.getTime();
  const slot = result.slots.find(isStart);
  if (!slot) {
    // Would it be free if nobody had booked? Then it's taken, not invalid.
    const freeWithoutBookings = computeAvailability({ ...engineInput, busy: [] }).slots.some(isStart);
    if (freeWithoutBookings) throw slotTaken(args.start, service.id);
    throw new FrontDeskError(
      "invalid_request",
      "That start time isn't available.",
      "Call get_availability and choose one of the returned starts.",
      { field: "start", value: args.start, service_id: service.id },
    );
  }

  let booking;
  try {
    booking = await deps.store.createBooking({
      shopSlug: shop.slug,
      serviceId: service.id,
      staffId: slot.staffId,
      start,
      end,
      customerName: args.customer_name,
      agentName: cleanAgentName(agentName),
      depositCents: service.depositCents,
    });
  } catch (err) {
    // Another booking won the race between step 2 and the insert.
    if (err instanceof SlotTakenError) throw slotTaken(args.start, service.id);
    throw err;
  }

  try {
    await deps.notifier.alertOwner(booking);
  } catch (err) {
    // The booking is already stored; failing now would make the agent retry into slot_taken.
    console.error(
      JSON.stringify({
        event: "booking.notify_failed",
        id: booking.id,
        shop: booking.shopSlug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const staffName = staffHours.find((s) => s.staffId === slot.staffId)?.staffName ?? slot.staffId;
  return { booking, staffName };
}

function slotTaken(start: string, serviceId: string): FrontDeskError {
  return new FrontDeskError(
    "slot_taken",
    "That time is already booked.",
    "Someone just took that time. Call get_availability again and choose another start.",
    { start, service_id: serviceId },
  );
}

function cleanAgentName(name: string): string {
  const trimmed = name.trim().slice(0, MAX_AGENT_NAME);
  return trimmed === "" ? UNKNOWN_AGENT : trimmed;
}

// ---- Bookings list (UI) ----

/** The bookings window the UI sees: this far back and ahead of now. */
export const BOOKINGS_PAST_DAYS = 7;
export const BOOKINGS_FUTURE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The shop and its bookings (confirmed and cancelled) from 7 days ago to 30 days ahead, sorted
 * by start.
 *
 * TODO(ring-2): owner sign-in. Until then anyone with the URL can read customer names.
 */
export async function listShopBookings(deps: FrontDeskDeps, shopSlug: string): Promise<BookingsResponse> {
  const shop = await deps.catalog.getShop(shopSlug);
  if (!shop) throw shopNotFound(shopSlug);
  const now = deps.clock.now().getTime();
  const bookings = await deps.store.listBookings(shopSlug, {
    start: new Date(now - BOOKINGS_PAST_DAYS * DAY_MS),
    end: new Date(now + BOOKINGS_FUTURE_DAYS * DAY_MS),
  });
  return { shop, bookings };
}
