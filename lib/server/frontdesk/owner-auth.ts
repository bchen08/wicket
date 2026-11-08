import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ApiError } from "../../types/frontdesk";

// Stub auth for the owner routes: one shared secret, OWNER_API_TOKEN. A request proves it holds the
// secret in one of two ways:
// - the header `Authorization: Bearer <token>` (curl, scripts); or
// - the fd_owner session cookie, which POST /api/owner/session sets after checking the token once, so
//   the v0 console never keeps the token in page code (see owner-session.ts).
// TODO(ring-2): owner sign-in by texted code replaces the token and this cookie.
//
// Never open: an unset or too-short token makes every owner route a 503, not a free pass.
// The token is never logged, never echoed in a response and never stored in the cookie.

/** Shortest OWNER_API_TOKEN accepted, after trimming. Anything shorter is treated as not configured. */
export const MIN_OWNER_TOKEN_LENGTH = 16;

/** The WWW-Authenticate challenge every 401 carries. */
export const OWNER_AUTH_CHALLENGE = 'Bearer realm="front-desk-owner"';

/** The owner session cookie. */
export const OWNER_SESSION_COOKIE = "fd_owner";

/** How long an owner session lasts, in seconds (the cookie's Max-Age): 12 hours. */
export const OWNER_SESSION_MAX_AGE_S = 12 * 60 * 60;

/** A refusal from checkOwnerAuth. Respond with `status`, `body` and `headers` as they are. */
export type OwnerAuthFailure = {
  ok: false;
  /** 401: no valid bearer token and no valid session cookie. 503: the deployment has no usable token. */
  status: 401 | 503;
  body: ApiError;
  /** Extra response headers: WWW-Authenticate on a 401, none otherwise. */
  headers: Record<string, string>;
};

/** What checkOwnerAuth decided. */
export type OwnerAuthResult = { ok: true } | OwnerAuthFailure;

const CONFIGURE_NEXT_ACTION =
  "Set OWNER_API_TOKEN (at least 16 random characters) in the deployment's environment variables, then redeploy.";

// "Bearer", then one or more spaces, then the token. The scheme is case-insensitive (RFC 7235).
const BEARER = /^Bearer +(.*)$/i;

// A session cookie value: the expiry in Unix seconds, ".", then the base64url HMAC-SHA256 (43 chars).
const SESSION_VALUE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

function notConfigured(message: string): OwnerAuthFailure {
  return {
    ok: false,
    status: 503,
    body: { error: { code: "internal", message, next_action: CONFIGURE_NEXT_ACTION } },
    headers: {},
  };
}

function unauthorized(): OwnerAuthFailure {
  return {
    ok: false,
    status: 401,
    body: {
      error: {
        code: "unauthorized",
        message: "Missing or invalid owner token.",
        next_action: "Send the header Authorization: Bearer <OWNER_API_TOKEN>.",
      },
    },
    headers: { "www-authenticate": OWNER_AUTH_CHALLENGE },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The configured owner token, trimmed, or the 503 to answer when it isn't usable: unset, blank, or
 * shorter than MIN_OWNER_TOKEN_LENGTH after trimming. Never open.
 */
export function configuredOwnerToken(configured: string | undefined): { ok: true; token: string } | OwnerAuthFailure {
  const token = configured?.trim() ?? "";
  if (token === "") {
    return notConfigured("The owner API is not configured on this deployment: OWNER_API_TOKEN is not set.");
  }
  if (token.length < MIN_OWNER_TOKEN_LENGTH) {
    return notConfigured(
      `The owner API is not configured on this deployment: OWNER_API_TOKEN is too short (at least ${MIN_OWNER_TOKEN_LENGTH} characters).`,
    );
  }
  return { ok: true, token };
}

/**
 * Whether `given` (trimmed) is the configured token `expected` (already trimmed). An empty `given`
 * never matches. Compared in constant time on sha256 digests, so neither the contents nor the length
 * of the configured token leak through timing.
 */
export function ownerTokenMatches(given: string, expected: string): boolean {
  const trimmed = given.trim();
  if (trimmed === "") return false;
  return timingSafeEqual(sha256(trimmed), sha256(expected));
}

// HMAC-SHA256 of "owner:<expiry>", keyed with the owner token: changing the token ends every session.
function sessionSignature(token: string, expiresAtS: string): string {
  return createHmac("sha256", token).update(`owner:${expiresAtS}`, "utf8").digest("base64url");
}

/** The fd_owner cookie value for a session that ends at `expiresAtS` (Unix seconds): "<expiresAtS>.<signature>". */
export function ownerSessionValue(token: string, expiresAtS: number): string {
  const expiry = String(expiresAtS);
  return `${expiry}.${sessionSignature(token, expiry)}`;
}

/** Every value the Cookie header gives `name`. A browser can send several cookies with one name. */
function cookieValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/**
 * When the request's owner session ends (Unix seconds), or null when it has no valid fd_owner cookie.
 * Valid means signed with `token` and ending after `nowMs`. The signature is compared in constant time.
 *
 * Sessions run on wall-clock time, not systemClock: the browser drops the cookie by its own clock
 * (Max-Age), and FRONTDESK_NOW must not freeze a session open.
 */
export function ownerSessionExpiry(request: Request, token: string, nowMs: number): number | null {
  for (const value of cookieValues(request, OWNER_SESSION_COOKIE)) {
    const match = SESSION_VALUE.exec(value);
    if (!match) continue;
    const expected = Buffer.from(sessionSignature(token, match[1]), "utf8");
    if (!timingSafeEqual(Buffer.from(match[2], "utf8"), expected)) continue;
    const expiresAtS = Number(match[1]);
    if (expiresAtS * 1000 > nowMs) return expiresAtS;
  }
  return null;
}

/**
 * Check that a request comes from the owner: a valid `Authorization: Bearer <token>` header, OR a
 * valid, unexpired fd_owner session cookie.
 *
 * - `configuredToken` unset, blank, or shorter than MIN_OWNER_TOKEN_LENGTH after trimming → 503
 *   (code `internal`) with a configuration message. Never open.
 * - The right bearer token, or a valid session cookie → ok, for any method. There's no extra CSRF
 *   check: the cookie is SameSite=Strict, so the browser never sends it on a request from another site.
 * - Otherwise (no header, another scheme, an empty or wrong token, no cookie, or an expired or
 *   tampered cookie) → 401 `unauthorized` with a WWW-Authenticate challenge.
 *
 * `nowMs` is for tests; it defaults to the wall clock.
 */
export function checkOwnerAuth(
  request: Request,
  configuredToken: string | undefined,
  nowMs: number = Date.now(),
): OwnerAuthResult {
  const configured = configuredOwnerToken(configuredToken);
  if (!configured.ok) return configured;

  const bearer = BEARER.exec(request.headers.get("authorization") ?? "");
  if (bearer && ownerTokenMatches(bearer[1], configured.token)) return { ok: true };

  if (ownerSessionExpiry(request, configured.token, nowMs) !== null) return { ok: true };
  return unauthorized();
}
