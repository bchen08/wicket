import type {
  ApiErrorCode,
  BlockResponse,
  BlocksResponse,
  BookingDetailResponse,
  BookingsResponse,
  HoursResponse,
  OwnerBookingActionResponse,
  PoliciesResponse,
  ServiceResponse,
  ServicesResponse,
} from "../../types/frontdesk";
import type { ManageAction } from "../engine/lifecycle";
import { FrontDeskError, toApiError } from "./errors";
import {
  createShopBlock,
  createShopService,
  deleteShopBlock,
  getBookingDetail,
  getShopHours,
  getShopPolicies,
  listShopBlocks,
  ownerBookingAction,
  replaceShopHours,
  updateShopPolicies,
  updateShopService,
} from "./owner";
import { checkOwnerAuth, UNLOCK_NEXT_ACTION } from "./owner-auth";
import { listServices, listShopBookings, withRequestOrigin, type FrontDeskDeps } from "./service";

// The HTTP side of the /api/shops/* routes: run a use case, return JSON or the ApiError envelope.
// Route files stay thin (await connection(), read params, call one of these), and tests drive these
// directly with in-memory deps.

/** The HTTP status for each error code. */
export const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  booking_not_found: 404,
  slot_taken: 409,
  paused: 409,
  not_cancellable: 409,
  outside_hours: 422,
  too_soon: 422,
  too_far: 422,
  outside_mandate: 422,
  approval_closed: 409,
  approval_expired: 410,
  internal: 500,
};

// Live data that may include customer names: never cache it anywhere.
export const NO_STORE = { "cache-control": "no-store" };

/** Whether the request is a plain HTML form post (the approval page, the console's unlock page). */
export function isFormPost(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data");
}

/** Any thrown value as an ApiError response with a matching status. Unexpected errors are logged. */
export function errorResponse(err: unknown): Response {
  const body = toApiError(err);
  if (body.error.code === "internal") console.error("[frontdesk/http] internal error", err);
  return Response.json(body, { status: STATUS[body.error.code], headers: NO_STORE });
}

/** Run a use case and answer JSON (`status` on success), or the ApiError envelope. */
export async function respond<T>(run: () => Promise<T>, status = 200): Promise<Response> {
  try {
    return Response.json(await run(), { status, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/shops/[shop]/services → ServicesResponse. `getDeps` is called inside, so config errors become a 500 envelope. */
export function servicesResponse(getDeps: () => FrontDeskDeps, shopSlug: string): Promise<Response> {
  return respond<ServicesResponse>(() => listServices(getDeps(), shopSlug));
}

// ---- Owner routes ----
// Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie. TODO(ring-2): owner sign-in replaces the token.

/** Options for the owner handlers. Tests pass getToken; routes use the default. */
export type OwnerOptions = {
  /** The configured owner token. Defaults to reading process.env.OWNER_API_TOKEN on every request. */
  getToken?: () => string | undefined;
};

const envToken = () => process.env.OWNER_API_TOKEN;

/**
 * Check owner auth, then run `run` with deps (baseUrl set to this request's origin) and answer JSON
 * (`status` on success). A 401 from checkOwnerAuth is returned as it is, before getDeps is called, so a
 * request without the token never touches the database. `unauthorizedNextAction` replaces the 401's
 * next_action for a wrong or missing token.
 */
async function ownerRespond<T>(
  getDeps: () => FrontDeskDeps,
  request: Request,
  options: OwnerOptions | undefined,
  run: (deps: FrontDeskDeps) => Promise<T>,
  status = 200,
  unauthorizedNextAction?: string,
): Promise<Response> {
  const auth = checkOwnerAuth(request, (options?.getToken ?? envToken)(), unauthorizedNextAction);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status, headers: { ...NO_STORE, ...auth.headers } });
  return respond(() => run(withRequestOrigin(getDeps(), request)), status);
}

/**
 * GET /api/shops/[shop]/bookings → BookingsResponse. An owner route: it shows customers' phone numbers.
 * Its 401 says to unlock the console, which forwards the browser's fd_owner cookie.
 */
export function bookingsResponse(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<BookingsResponse>(getDeps, request, options, (deps) => listShopBookings(deps, shopSlug), 200, UNLOCK_NEXT_ACTION);
}

/**
 * The request's JSON body. An empty or malformed body is invalid_request (field "body"). Call it
 * inside respond's `run`, so the error becomes a 400 envelope.
 */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  const fail = (message: string) =>
    new FrontDeskError("invalid_request", message, "Send a JSON object as the request body, with Content-Type: application/json.", {
      field: "body",
      issues: [{ path: "body", message }],
    });
  if (text.trim() === "") throw fail("The request body is empty.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw fail("The request body isn't valid JSON.");
  }
}

/** GET /api/shops/[shop]/policies → PoliciesResponse. */
export function policiesGet(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<PoliciesResponse>(getDeps, request, options, (deps) => getShopPolicies(deps, shopSlug));
}

/** PUT /api/shops/[shop]/policies (UpdatePoliciesRequest) → PoliciesResponse. */
export function policiesPut(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<PoliciesResponse>(getDeps, request, options, async (deps) =>
    updateShopPolicies(deps, shopSlug, await readJson(request)),
  );
}

/** GET /api/shops/[shop]/hours → HoursResponse. */
export function hoursGet(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<HoursResponse>(getDeps, request, options, (deps) => getShopHours(deps, shopSlug));
}

/** PUT /api/shops/[shop]/hours (UpdateHoursRequest) → HoursResponse. */
export function hoursPut(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<HoursResponse>(getDeps, request, options, async (deps) =>
    replaceShopHours(deps, shopSlug, await readJson(request)),
  );
}

/** GET /api/shops/[shop]/blocks?from=&to= → BlocksResponse. */
export function blocksGet(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<BlocksResponse>(getDeps, request, options, (deps) => {
    const query = new URL(request.url).searchParams;
    return listShopBlocks(deps, shopSlug, { from: query.get("from"), to: query.get("to") });
  });
}

/** POST /api/shops/[shop]/blocks (CreateBlockRequest) → 201 BlockResponse. */
export function blocksPost(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<BlockResponse>(
    getDeps,
    request,
    options,
    async (deps) => createShopBlock(deps, shopSlug, await readJson(request)),
    201,
  );
}

/** DELETE /api/shops/[shop]/blocks?id=<uuid> → BlockResponse (the deleted block). */
export function blocksDelete(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<BlockResponse>(getDeps, request, options, (deps) =>
    deleteShopBlock(deps, shopSlug, new URL(request.url).searchParams.get("id")),
  );
}

/** POST /api/shops/[shop]/services (CreateServiceRequest) → 201 ServiceResponse. */
export function servicesPost(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<ServiceResponse>(
    getDeps,
    request,
    options,
    async (deps) => createShopService(deps, shopSlug, await readJson(request)),
    201,
  );
}

/** PATCH /api/shops/[shop]/services/[id] (UpdateServiceRequest) → ServiceResponse. */
export function servicePatch(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  serviceId: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<ServiceResponse>(getDeps, request, options, async (deps) =>
    updateShopService(deps, shopSlug, serviceId, await readJson(request)),
  );
}

/** POST /api/shops/[shop]/bookings/[id]/cancel, /complete or /no-show → OwnerBookingActionResponse. Ignores the body. */
export function bookingActionPost(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  bookingId: string,
  action: ManageAction,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<OwnerBookingActionResponse>(getDeps, request, options, (deps) =>
    ownerBookingAction(deps, shopSlug, bookingId, action),
  );
}

/** GET /api/shops/[shop]/bookings/[id] → BookingDetailResponse. */
export function bookingDetailGet(
  getDeps: () => FrontDeskDeps,
  request: Request,
  shopSlug: string,
  bookingId: string,
  options?: OwnerOptions,
): Promise<Response> {
  return ownerRespond<BookingDetailResponse>(getDeps, request, options, (deps) =>
    getBookingDetail(deps, shopSlug, bookingId),
  );
}
