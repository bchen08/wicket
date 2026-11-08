import type { ApiError, OwnerSessionResponse } from "../../types/frontdesk";
import { FrontDeskError } from "./errors";
import { errorResponse, isFormPost } from "./http";
import {
  configuredOwnerToken,
  hasOwnerCookie,
  NOT_SET_UP_NEXT_ACTION,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_MAX_AGE_S,
  ownerTokenMatches,
  ownerUnauthorized,
} from "./owner-auth";

// The handlers behind POST, GET and DELETE /api/owner/session: the stub owner session. The owner
// enters the shop's access code (OWNER_API_TOKEN) once, at /console/unlock or as JSON; the answer sets
// the fd_owner cookie to it (HttpOnly, so page code can't read it), and checkOwnerAuth accepts that
// cookie on every owner route.
// TODO(ring-2): owner sign-in by texted code replaces this.

// Never cache: the answer depends on the caller's cookie.
const NO_STORE = { "cache-control": "no-store" };

// Hosts where the cookie is set without Secure over plain http, so `pnpm dev` and `next start` work in
// every browser. On Vercel it is always Secure.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether this is plain http on this machine (and not Vercel): the one case without Secure. */
function isLocalHttp(request: Request): boolean {
  if (process.env.VERCEL) return false;
  const url = new URL(request.url);
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

const SEND_TOKEN_NEXT_ACTION = 'Send a JSON object { "token": "<OWNER_API_TOKEN>" } as the request body.';

/** Options for the session handlers. Tests pass these; the route uses the defaults. */
export type OwnerSessionOptions = {
  /** The configured owner token. Defaults to reading process.env.OWNER_API_TOKEN on every request. */
  getToken?: () => string | undefined;
  /** Wall-clock milliseconds, for expiresAt. Defaults to Date.now. */
  now?: () => number;
};

const envToken = () => process.env.OWNER_API_TOKEN;

function json(body: OwnerSessionResponse | ApiError, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** A 303 to `path` on the request's origin, with extra headers (e.g. Set-Cookie). */
function seeOther(request: Request, path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, ...headers, location: new URL(path, request.url).toString() } });
}

/** RFC 3339 in UTC, without milliseconds: "2026-11-08T10:00:00Z". */
function rfc3339(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * The Set-Cookie header for fd_owner: the token itself, URI-encoded. HttpOnly, SameSite=Lax, Path=/,
 * Max-Age=43200, Secure except on plain-http localhost. An empty value with Max-Age 0 clears it.
 */
function sessionCookie(request: Request, value: string, maxAgeS: number): string {
  const parts = [`${OWNER_SESSION_COOKIE}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${maxAgeS}`, "HttpOnly", "SameSite=Lax"];
  if (!isLocalHttp(request)) parts.push("Secure");
  return parts.join("; ");
}

function invalidField(field: string, message: string): FrontDeskError {
  return new FrontDeskError("invalid_request", message, SEND_TOKEN_NEXT_ACTION, {
    field,
    issues: [{ path: field, message }],
  });
}

/** The `token` from a JSON POST body, or invalid_request (400) naming what's wrong. */
function readToken(text: string): string {
  if (text.trim() === "") throw invalidField("body", "The request body is empty.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidField("body", "The request body isn't valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalidField("body", "The request body must be a JSON object.");
  }
  const token = (body as Record<string, unknown>).token;
  if (typeof token !== "string") throw invalidField("token", "token must be a string: the OWNER_API_TOKEN.");
  return token;
}

/**
 * POST /api/owner/session → sets the fd_owner cookie.
 * - JSON (OwnerSessionRequest) → 200 OwnerSessionResponse; bad body → 400 invalid_request; wrong token,
 *   or OWNER_API_TOKEN not set → 401 unauthorized.
 * - Form post (`token` field) → 303 /console with the cookie; a wrong or missing token → 303
 *   /console/unlock?error=1.
 */
export async function ownerSessionPost(request: Request, options: OwnerSessionOptions = {}): Promise<Response> {
  const configured = (options.getToken ?? envToken)();
  const cookie = () => {
    const expiresAtS = Math.floor((options.now ?? Date.now)() / 1000) + OWNER_SESSION_MAX_AGE_S;
    return { expiresAtS, header: sessionCookie(request, configuredOwnerToken(configured), OWNER_SESSION_MAX_AGE_S) };
  };

  if (isFormPost(request)) {
    let given: FormDataEntryValue | null = null;
    try {
      given = (await request.formData()).get("token");
    } catch {
      // A malformed form body is a wrong token.
    }
    if (typeof given !== "string" || !ownerTokenMatches(given, configured)) return seeOther(request, "/console/unlock?error=1");
    return seeOther(request, "/console", { "set-cookie": cookie().header });
  }

  if (configuredOwnerToken(configured) === "") {
    const failure = ownerUnauthorized("Owner access isn't set up on this deployment.", NOT_SET_UP_NEXT_ACTION);
    return json(failure.body, failure.status, failure.headers);
  }
  let given: string;
  try {
    given = readToken(await request.text());
  } catch (err) {
    return errorResponse(err);
  }
  if (!ownerTokenMatches(given, configured)) {
    const failure = ownerUnauthorized("Wrong owner token.", 'Check the deployment\'s OWNER_API_TOKEN, then send it again as { "token": "…" }.');
    return json(failure.body, failure.status, failure.headers);
  }
  const { expiresAtS, header } = cookie();
  return json({ signedIn: true, expiresAt: rfc3339(expiresAtS) }, 200, { "set-cookie": header });
}

/** GET /api/owner/session → OwnerSessionResponse: whether this browser holds an fd_owner cookie with the right token. */
export function ownerSessionGet(request: Request, options: OwnerSessionOptions = {}): Response {
  return json({ signedIn: hasOwnerCookie(request, (options.getToken ?? envToken)()) }, 200);
}

/** DELETE /api/owner/session → OwnerSessionResponse `{ signedIn: false }`, clearing the cookie. Always 200. */
export function ownerSessionDelete(request: Request): Response {
  return json({ signedIn: false }, 200, { "set-cookie": sessionCookie(request, "", 0) });
}
