import type {
  GetAvailabilityInput,
  GetAvailabilityResult,
  ListServicesResult,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { computeAvailability, validateRequest } from "../engine/availability";
import type { ShopCatalog } from "./catalog";
import { FrontDeskError } from "./errors";
import { parseRfc3339 } from "./time";

// Transport-agnostic use cases behind the MCP tools. They take their dependencies as
// arguments so tests can pass a fixed clock and the next slice can pass a Postgres catalog.

export type FrontDeskDeps = {
  catalog: ShopCatalog;
  clock: Clock;
};

function shopNotFound(slug: string): FrontDeskError {
  return new FrontDeskError(
    "not_found",
    `No shop with slug "${slug}".`,
    "Check the shop slug. Front Desk currently serves one shop: harts.",
    { shop: slug },
  );
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

  // A slot may start just before `to` and run past it, so fetch busy time up to
  // to + duration; otherwise a booking right after the window could be missed.
  const busyUntil = new Date(to.getTime() + service.durationMin * 60_000);
  const [staffHours, busy] = await Promise.all([
    deps.catalog.getStaffHours(shopSlug),
    deps.catalog.getBusyIntervals(shopSlug, { start: from, end: busyUntil }),
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
  });
}
