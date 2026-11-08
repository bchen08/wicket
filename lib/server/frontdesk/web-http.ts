import type { BookingPageResponse, FrontDeskDiscovery, WebAvailabilityResponse, WebBookResponse } from "../../types/frontdesk";
import { FrontDeskError, toApiError } from "./errors";
import { errorResponse, isFormPost, NO_STORE, readJson, respond } from "./http";
import { withRequestOrigin, type FrontDeskDeps } from "./service";
import { agentsMd, bookingPage, discovery, forWeb, webAvailability, webBook, type WebBookFields } from "./web-booking";

// The HTTP side of the web booking API: public routes, no auth, JSON (agents.md is plain text). Route
// files stay thin (await connection(), read params, call one of these), and tests drive these directly
// with in-memory deps. Every handler sets deps.baseUrl to the request's origin, so approval links and
// the URLs in agents.md point where the caller is.

/** GET /api/shops/[shop]/availability?service=<id>&from=<YYYY-MM-DD>&days=<1..14> → WebAvailabilityResponse. */
export function availabilityGet(getDeps: () => FrontDeskDeps, request: Request, shopSlug: string): Promise<Response> {
  return respond<WebAvailabilityResponse>(async () => {
    const query = new URL(request.url).searchParams;
    try {
      return await webAvailability(withRequestOrigin(getDeps(), request), shopSlug, {
        service: query.get("service"),
        from: query.get("from"),
        days: query.get("days"),
      });
    } catch (err) {
      throw forWeb(err, shopSlug);
    }
  });
}

const BODY_NEXT =
  'Send a JSON object such as {"service":"haircut","start":"<a slot start>","name":"Maya"} with ' +
  "Content-Type: application/json, or post an HTML form with those fields.";

/** A JSON book body: an object, or invalid_request (field "body"). */
async function readBookJson(request: Request): Promise<WebBookFields> {
  const body = await readJson(request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new FrontDeskError("invalid_request", "The request body must be a JSON object.", BODY_NEXT, { field: "body" });
  }
  return body as WebBookFields;
}

/** A form post's book fields, as strings (a file upload counts as absent). Unknown fields are ignored. */
async function readBookForm(request: Request): Promise<WebBookFields> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new FrontDeskError("invalid_request", "The form data couldn't be read.", BODY_NEXT, { field: "body" });
  }
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };
  return { service: text("service"), start: text("start"), name: text("name"), bookedBy: text("bookedBy"), phone: text("phone") };
}

/** A 303 See Other to `location`, never cached. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
}

/** The page a form was posted from (the Referer), if it's an http(s) URL, without its #fragment. */
function referringPage(request: Request): URL | null {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/**
 * A form post: 303 → the booking's approval page on success. On a refusal, 303 back to the page the form
 * was on with ?error=<code>&message=<text> (other query parameters kept); without a usable Referer,
 * the ApiError envelope as JSON with its status.
 */
async function formBook(getDeps: () => FrontDeskDeps, request: Request, shopSlug: string): Promise<Response> {
  try {
    const fields = await readBookForm(request);
    const { approvalUrl } = await webBook(withRequestOrigin(getDeps(), request), shopSlug, fields, request.headers.get("user-agent"));
    return seeOther(approvalUrl);
  } catch (err) {
    const back = referringPage(request);
    if (!back) return errorResponse(err);
    const { error } = toApiError(err);
    if (error.code === "internal") console.error("[frontdesk/web] internal error", err);
    back.searchParams.set("error", error.code);
    back.searchParams.set("message", error.message);
    return seeOther(back.toString());
  }
}

/**
 * POST /api/shops/[shop]/book. JSON (WebBookRequest) → 201 WebBookResponse, or the ApiError envelope.
 * A plain HTML form post (service, start, name, bookedBy, phone) → 303 to the approval page, or back to the
 * Referer with ?error=<code>&message=<text>.
 */
export function bookPost(getDeps: () => FrontDeskDeps, request: Request, shopSlug: string): Promise<Response> {
  if (isFormPost(request)) return formBook(getDeps, request, shopSlug);
  return respond<WebBookResponse>(async () => {
    const fields = await readBookJson(request);
    const { response } = await webBook(withRequestOrigin(getDeps(), request), shopSlug, fields, request.headers.get("user-agent"));
    return response;
  }, 201);
}

/** GET /api/shops/[shop]/booking-page → BookingPageResponse. */
export function bookingPageGet(getDeps: () => FrontDeskDeps, request: Request, shopSlug: string): Promise<Response> {
  return respond<BookingPageResponse>(async () => {
    try {
      return await bookingPage(withRequestOrigin(getDeps(), request), shopSlug);
    } catch (err) {
      throw forWeb(err, shopSlug);
    }
  });
}

/** GET /api/shops/[shop]/agents.md → plain text for agents; errors are the ApiError envelope as JSON. */
export async function agentsMdGet(getDeps: () => FrontDeskDeps, request: Request, shopSlug: string): Promise<Response> {
  try {
    const text = await agentsMd(withRequestOrigin(getDeps(), request), shopSlug);
    return new Response(text, { status: 200, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /.well-known/front-desk.json (rewritten to /api/well-known/front-desk) → FrontDeskDiscovery. Reads no data. */
export function discoveryGet(request: Request): Response {
  const body: FrontDeskDiscovery = discovery(new URL(request.url).origin);
  return Response.json(body, { status: 200, headers: NO_STORE });
}
