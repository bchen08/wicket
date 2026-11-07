import type { ApiError, OwnerSessionResponse } from "../../types/frontdesk";
import { FrontDeskError } from "./errors";
import { errorResponse } from "./http";
import {
  configuredOwnerToken,
  OWNER_AUTH_CHALLENGE,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_MAX_AGE_S,
  ownerSessionExpiry,
  ownerSessionValue,
  ownerTokenMatches,
  requestOrigin,
} from "./owner-auth";

// The handlers behind POST, GET and DELETE /api/owner/session: the stub owner session. The owner's
// console sends OWNER_API_TOKEN once; the answer sets the fd_owner cookie (HttpOnly, so page code
// can't read it), and checkOwnerAuth accepts that cookie on every owner route.
// The cookie holds an expiry and an HMAC of it keyed with the token, never the token itself.
// TODO(ring-2): owner sign-in by texted code replaces this; also move GET /api/shops/[shop]/bookings
// behind owner auth then.

/** Sign-in attempts allowed per client IP per window. */
export const SESSION_ATTEMPT_LIMIT = 10;

/** The rate-limit window: 15 minutes. */
export const SESSION_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Never cache: the answer depends on the caller's cookie.
const NO_STORE = { "cache-control": "no-store" };

// The only hosts where the cookie is set without Secure, over plain http, so `pnpm dev` works in every
// browser. Everywhere else (every Vercel deployment) it is Secure.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether the browser reached us at http://localhost (or a loopback address), any port. */
function isLocalHttp(request: Request): boolean {
  const origin = requestOrigin(request);
  if (origin === null) return false;
  const url = new URL(origin);
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

const SEND_TOKEN_NEXT_ACTION = 'Send a JSON object { "token": "<OWNER_API_TOKEN>" } as the request body.';

/** Counts sign-in attempts per key (the client IP) in a sliding window. */
export type AttemptLimiter = {
  /**
   * Record one attempt by `key` at `nowMs`. Returns 0 if it's allowed, otherwise the seconds until
   * the next attempt will be (a refused attempt isn't counted).
   */
  attempt(key: string, nowMs: number): number;
};

/**
 * An in-memory AttemptLimiter: `limit` attempts per key per `windowMs`.
 *
 * Stub-grade: the counts live in one server instance's memory. On Vercel each instance counts on its
 * own and a cold start resets them, so the real limit is looser than it reads. It tracks at most
 * `maxKeys` keys, dropping the least recently seen first.
 */
export function createAttemptLimiter(
  limit = SESSION_ATTEMPT_LIMIT,
  windowMs = SESSION_ATTEMPT_WINDOW_MS,
  maxKeys = 10_000,
): AttemptLimiter {
  // Insertion order is least recently seen first: every attempt re-inserts its key.
  const attempts = new Map<string, number[]>();
  return {
    attempt(key, nowMs) {
      const recent = (attempts.get(key) ?? []).filter((at) => at > nowMs - windowMs);
      attempts.delete(key);
      if (recent.length >= limit) {
        attempts.set(key, recent);
        return Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000));
      }
      recent.push(nowMs);
      attempts.set(key, recent);
      for (const oldest of attempts.keys()) {
        if (attempts.size <= maxKeys) break;
        attempts.delete(oldest);
      }
      return 0;
    },
  };
}

const defaultLimiter = createAttemptLimiter();

/** Options for the session handlers. Tests pass these; the route uses the defaults. */
export type OwnerSessionOptions = {
  /** The configured owner token. Defaults to reading process.env.OWNER_API_TOKEN on every request. */
  getToken?: () => string | undefined;
  /** Wall-clock milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to one limiter shared by every request this server instance handles. */
  limiter?: AttemptLimiter;
};

const envToken = () => process.env.OWNER_API_TOKEN;

function json(body: OwnerSessionResponse | ApiError, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * The caller's IP, for the rate limit: the first X-Forwarded-For entry (Vercel overwrites the header
 * with the real client address), then X-Real-IP. Without either, every caller shares "unknown".
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** RFC 3339 in UTC, without milliseconds: "2026-11-08T10:00:00Z". */
function rfc3339(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** The Set-Cookie header for fd_owner. An empty value with Max-Age 0 clears it. */
function sessionCookie(request: Request, value: string, maxAgeS: number): string {
  const parts = [`${OWNER_SESSION_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAgeS}`, "HttpOnly", "SameSite=Strict"];
  if (!isLocalHttp(request)) parts.push("Secure");
  return parts.join("; ");
}

function invalidField(field: string, message: string): FrontDeskError {
  return new FrontDeskError("invalid_request", message, SEND_TOKEN_NEXT_ACTION, {
    field,
    issues: [{ path: field, message }],
  });
}

/** The `token` from a POST body, or invalid_request (400) naming what's wrong. */
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

function wrongToken(): ApiError {
  return {
    error: {
      code: "unauthorized",
      message: "Wrong owner token.",
      next_action: "Check the deployment's OWNER_API_TOKEN, then send it again as { \"token\": \"…\" }.",
    },
  };
}

// TODO: use the rate_limited code once it exists on main (claude/15-ring1b-consent adds it, with the
// same details.retryAfter). Until then this is invalid_request with status 429.
function tooManyAttempts(retryAfterS: number): ApiError {
  return {
    error: {
      code: "invalid_request",
      message: `Too many sign-in attempts from this address: at most ${SESSION_ATTEMPT_LIMIT} per ${SESSION_ATTEMPT_WINDOW_MS / 60_000} minutes.`,
      next_action: `Wait ${Math.ceil(retryAfterS / 60)} minute(s) (details.retryAfter seconds), then try again.`,
      details: { retryAfter: retryAfterS },
    },
  };
}

/**
 * POST /api/owner/session (OwnerSessionRequest) → OwnerSessionResponse, setting the fd_owner cookie.
 *
 * Every attempt counts toward the rate limit, which is checked first: over it → 429 with Retry-After.
 * Then: token not configured → 503; bad body → 400 invalid_request; wrong token → 401 unauthorized.
 */
export async function ownerSessionPost(request: Request, options: OwnerSessionOptions = {}): Promise<Response> {
  const nowMs = (options.now ?? Date.now)();
  const retryAfterS = (options.limiter ?? defaultLimiter).attempt(clientIp(request), nowMs);
  if (retryAfterS > 0) return json(tooManyAttempts(retryAfterS), 429, { "retry-after": String(retryAfterS) });

  const configured = configuredOwnerToken((options.getToken ?? envToken)());
  if (!configured.ok) return json(configured.body, configured.status, configured.headers);

  let given: string;
  try {
    given = readToken(await request.text());
  } catch (err) {
    return errorResponse(err);
  }
  if (!ownerTokenMatches(given, configured.token)) {
    return json(wrongToken(), 401, { "www-authenticate": OWNER_AUTH_CHALLENGE });
  }

  const expiresAtS = Math.floor(nowMs / 1000) + OWNER_SESSION_MAX_AGE_S;
  const value = ownerSessionValue(configured.token, expiresAtS);
  return json({ signedIn: true, expiresAt: rfc3339(expiresAtS) }, 200, {
    "set-cookie": sessionCookie(request, value, OWNER_SESSION_MAX_AGE_S),
  });
}

/**
 * GET /api/owner/session → OwnerSessionResponse: whether this browser holds a valid, unexpired
 * session. Token not configured → 503, so the console can say so instead of offering a sign-in that
 * can't work.
 */
export function ownerSessionGet(request: Request, options: OwnerSessionOptions = {}): Response {
  const configured = configuredOwnerToken((options.getToken ?? envToken)());
  if (!configured.ok) return json(configured.body, configured.status, configured.headers);
  const expiresAtS = ownerSessionExpiry(request, configured.token, (options.now ?? Date.now)());
  return json(expiresAtS === null ? { signedIn: false } : { signedIn: true, expiresAt: rfc3339(expiresAtS) }, 200);
}

/** DELETE /api/owner/session → OwnerSessionResponse `{ signedIn: false }`, clearing the cookie. Always 200. */
export function ownerSessionDelete(request: Request): Response {
  return json({ signedIn: false }, 200, { "set-cookie": sessionCookie(request, "", 0) });
}
