import type { ApiErrorCode, BookingsResponse, ServicesResponse } from "../../types/frontdesk";
import { toApiError } from "./errors";
import { listServices, listShopBookings, type FrontDeskDeps } from "./service";

// The HTTP side of the /api/shops/* routes: run a use case, return JSON or the ApiError envelope.
// Route files stay thin (await connection(), read params, call one of these), and tests drive these
// directly with in-memory deps.

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  slot_taken: 409,
  internal: 500,
};

// Live data that may include customer names: never cache it anywhere.
const NO_STORE = { "cache-control": "no-store" };

/** Any thrown value as an ApiError response with a matching status. Unexpected errors are logged. */
export function errorResponse(err: unknown): Response {
  const body = toApiError(err);
  if (body.error.code === "internal") console.error("[frontdesk/http] internal error", err);
  return Response.json(body, { status: STATUS[body.error.code], headers: NO_STORE });
}

async function respond<T>(run: () => Promise<T>): Promise<Response> {
  try {
    return Response.json(await run(), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/shops/[shop]/services → ServicesResponse. `getDeps` is called inside, so config errors become a 500 envelope. */
export function servicesResponse(getDeps: () => FrontDeskDeps, shopSlug: string): Promise<Response> {
  return respond<ServicesResponse>(() => listServices(getDeps(), shopSlug));
}

/** GET /api/shops/[shop]/bookings → BookingsResponse. */
export function bookingsResponse(getDeps: () => FrontDeskDeps, shopSlug: string): Promise<Response> {
  return respond<BookingsResponse>(() => listShopBookings(getDeps(), shopSlug));
}
