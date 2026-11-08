import type { ApiError } from "../../types/frontdesk";

// Stub auth for the owner routes: one shared secret, OWNER_API_TOKEN (the shop's access code). A
// request proves it holds the secret in one of two ways:
// - the header `Authorization: Bearer <token>` (curl, scripts); or
// - the fd_owner cookie, which POST /api/owner/session sets to the token (see owner-session.ts). It is
//   HttpOnly, so the console's page code never reads it. A code texted to the owner (owner-code.ts, where
//   texting is on) gets the same cookie.
// TODO(ring-2): per-owner sign-in replaces the shared token.
//
// An unset or empty OWNER_API_TOKEN matches nothing: an empty token must not match an empty header.

/** The WWW-Authenticate challenge every 401 carries. */
export const OWNER_AUTH_CHALLENGE = 'Bearer realm="front-desk-owner"';

/** The owner session cookie. Its value is the token, URI-encoded. */
export const OWNER_SESSION_COOKIE = "fd_owner";

/** How long the owner session cookie lasts, in seconds (its Max-Age): 12 hours. */
export const OWNER_SESSION_MAX_AGE_S = 12 * 60 * 60;

/** next_action of a 401 when OWNER_API_TOKEN isn't set. */
export const NOT_SET_UP_NEXT_ACTION = "Owner access isn't set up: set OWNER_API_TOKEN in Vercel and redeploy.";

/** next_action of a 401 from an owner route, for scripts and curl. */
export const BEARER_NEXT_ACTION = "Send the header Authorization: Bearer <OWNER_API_TOKEN>.";

/** next_action of a 401 from the bookings list, which the console reads. */
export const UNLOCK_NEXT_ACTION = "Open /console/unlock and enter the shop's access code.";

/** A refusal from checkOwnerAuth. Respond with `status`, `body` and `headers` as they are. */
export type OwnerAuthFailure = {
  ok: false;
  status: 401;
  body: ApiError;
  /** WWW-Authenticate. */
  headers: Record<string, string>;
};

/** What checkOwnerAuth decided. */
export type OwnerAuthResult = { ok: true } | OwnerAuthFailure;

/** A 401 `unauthorized` with `nextAction`. */
export function ownerUnauthorized(message: string, nextAction: string): OwnerAuthFailure {
  return {
    ok: false,
    status: 401,
    body: { error: { code: "unauthorized", message, next_action: nextAction } },
    headers: { "www-authenticate": OWNER_AUTH_CHALLENGE },
  };
}

/** The configured token, trimmed (a pasted value often ends in a newline), or "" when it isn't set. */
export function configuredOwnerToken(configured: string | undefined): string {
  return configured?.trim() ?? "";
}

/** Whether `given` (trimmed) is the configured token. Nothing matches an unset or empty token. */
export function ownerTokenMatches(given: string | null | undefined, configured: string | undefined): boolean {
  const expected = configuredOwnerToken(configured);
  return expected !== "" && given?.trim() === expected;
}

/** Every value the Cookie header gives `name`, URI-decoded. A browser can send several cookies with one name. */
export function cookieValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      values.push(decodeURIComponent(raw));
    } catch {
      values.push(raw);
    }
  }
  return values;
}

/** Whether the request carries an fd_owner cookie holding the configured token. */
export function hasOwnerCookie(request: Request, configured: string | undefined): boolean {
  return cookieValues(request, OWNER_SESSION_COOKIE).some((value) => ownerTokenMatches(value, configured));
}

// "Bearer", then one or more spaces, then the token. The scheme is case-insensitive (RFC 7235).
const BEARER = /^Bearer +(.*)$/i;

/**
 * Check that a request comes from the owner: `Authorization: Bearer <token>` or an fd_owner cookie
 * holding the token, compared to OWNER_API_TOKEN with ===. Otherwise 401 `unauthorized`:
 * - OWNER_API_TOKEN unset or empty → next_action NOT_SET_UP_NEXT_ACTION;
 * - a missing or wrong token → `unauthorizedNextAction` (default BEARER_NEXT_ACTION).
 */
export function checkOwnerAuth(
  request: Request,
  configuredToken: string | undefined,
  unauthorizedNextAction: string = BEARER_NEXT_ACTION,
): OwnerAuthResult {
  if (configuredOwnerToken(configuredToken) === "") {
    return ownerUnauthorized("Owner access isn't set up on this deployment.", NOT_SET_UP_NEXT_ACTION);
  }
  const bearer = BEARER.exec(request.headers.get("authorization") ?? "");
  if (bearer && ownerTokenMatches(bearer[1], configuredToken)) return { ok: true };
  if (hasOwnerCookie(request, configuredToken)) return { ok: true };
  return ownerUnauthorized("Missing or wrong owner token.", unauthorizedNextAction);
}
