import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiError } from "../../types/frontdesk";

// Stub auth for the owner routes: one shared secret, OWNER_API_TOKEN, sent as a bearer token.
// TODO(ring-2): owner sign-in replaces the token.
//
// Never open: an unset or too-short token makes every owner route a 503, not a free pass.
// The token is never logged and never echoed in a response.

/** Shortest OWNER_API_TOKEN accepted, after trimming. Anything shorter is treated as not configured. */
export const MIN_OWNER_TOKEN_LENGTH = 16;

/** The WWW-Authenticate challenge every 401 carries. */
export const OWNER_AUTH_CHALLENGE = 'Bearer realm="front-desk-owner"';

/** What checkOwnerAuth decided. On failure, respond with `status`, `body` and `headers` as they are. */
export type OwnerAuthResult =
  | { ok: true }
  | {
      ok: false;
      /** 401: the caller sent no token or the wrong one. 503: the deployment has no usable token. */
      status: 401 | 503;
      body: ApiError;
      /** Extra response headers: WWW-Authenticate on a 401, none on a 503. */
      headers: Record<string, string>;
    };

const CONFIGURE_NEXT_ACTION =
  "Set OWNER_API_TOKEN (at least 16 random characters) in the deployment's environment variables, then redeploy.";

// "Bearer", then one or more spaces, then the token. The scheme is case-insensitive (RFC 7235).
const BEARER = /^Bearer +(.*)$/i;

function notConfigured(message: string): OwnerAuthResult {
  return {
    ok: false,
    status: 503,
    body: { error: { code: "internal", message, next_action: CONFIGURE_NEXT_ACTION } },
    headers: {},
  };
}

function unauthorized(): OwnerAuthResult {
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
 * Check a request's `Authorization: Bearer <token>` header against the configured owner token.
 *
 * - `configuredToken` unset, blank, or shorter than MIN_OWNER_TOKEN_LENGTH after trimming → 503
 *   (code `internal`) with a configuration message. Never open.
 * - No Authorization header, another scheme, an empty token or the wrong token → 401 (code
 *   `unauthorized`) with a WWW-Authenticate challenge.
 *
 * Both tokens are trimmed, then compared in constant time on their sha256 digests, so neither the
 * contents nor the length of the configured token leak through timing.
 */
export function checkOwnerAuth(request: Request, configuredToken: string | undefined): OwnerAuthResult {
  const expected = configuredToken?.trim() ?? "";
  if (expected === "") {
    return notConfigured("The owner API is not configured on this deployment: OWNER_API_TOKEN is not set.");
  }
  if (expected.length < MIN_OWNER_TOKEN_LENGTH) {
    return notConfigured(
      `The owner API is not configured on this deployment: OWNER_API_TOKEN is too short (at least ${MIN_OWNER_TOKEN_LENGTH} characters).`,
    );
  }

  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  const given = match?.[1].trim() ?? "";
  if (given === "") return unauthorized();
  return timingSafeEqual(sha256(given), sha256(expected)) ? { ok: true } : unauthorized();
}
