import type { ApiError, OwnerSessionResponse } from "../../types/frontdesk";
import { getFrontDeskDeps } from "./deps";
import { FrontDeskError } from "./errors";
import { errorResponse, isFormPost } from "./http";
import { redeemOwnerCode } from "./owner-code";
import type { FrontDeskDeps } from "./service";
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
// enters the shop's access code (OWNER_API_TOKEN) once, at /console/unlock or as JSON, or a code texted to
// their mobile by POST /api/owner/code (owner-code.ts, where texting is on); the answer sets the fd_owner
// cookie to the access code (HttpOnly, so page code can't read it), and checkOwnerAuth accepts that cookie
// on every owner route.

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
  /** Where texted codes are checked (deps.store, deps.clock). Defaults to getFrontDeskDeps; only read for a code. */
  getDeps?: () => FrontDeskDeps;
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

/** What a JSON POST body signs in with: the access code, or a texted code. */
type Credential = { token: string } | { code: string };

/** The `token` or `code` from a JSON POST body (`code` when it has one), or invalid_request (400) naming what's wrong. */
function readCredential(text: string): Credential {
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
  const { token, code } = body as Record<string, unknown>;
  if (code !== undefined && code !== null) {
    if (typeof code !== "string") throw invalidField("code", "code must be a string: the 6 digits texted to the owner.");
    return { code };
  }
  if (typeof token !== "string") throw invalidField("token", "token must be a string: the OWNER_API_TOKEN.");
  return { token };
}

const WRONG_CODE_NEXT_ACTION = "Ask for a new code with POST /api/owner/code (it works once, for 10 minutes), or sign in with the access code.";

/**
 * POST /api/owner/session → sets the fd_owner cookie.
 * - JSON (OwnerSessionRequest: { token } or { code }) → 200 OwnerSessionResponse; bad body → 400
 *   invalid_request; wrong token, a wrong, used or expired code, or OWNER_API_TOKEN not set → 401 unauthorized.
 * - Form post (`token` field) → 303 /console with the cookie; a wrong or missing token → 303
 *   /console/unlock?error=1. Form post with a `code` field → 303 /console, or → /console/unlock?error=code.
 * A code is checked only when OWNER_API_TOKEN is set (the cookie holds it), so a code isn't used up for nothing.
 */
export async function ownerSessionPost(request: Request, options: OwnerSessionOptions = {}): Promise<Response> {
  const configured = (options.getToken ?? envToken)();
  const cookie = () => {
    const expiresAtS = Math.floor((options.now ?? Date.now)() / 1000) + OWNER_SESSION_MAX_AGE_S;
    return { expiresAtS, header: sessionCookie(request, configuredOwnerToken(configured), OWNER_SESSION_MAX_AGE_S) };
  };

  /** Whether `code` is a good texted code (and use it up). Only when the cookie can be set. */
  const codeWorks = async (code: string) =>
    configuredOwnerToken(configured) !== "" && (await redeemOwnerCode((options.getDeps ?? getFrontDeskDeps)(), code));

  if (isFormPost(request)) {
    let form: FormData | null = null;
    try {
      form = await request.formData();
    } catch {
      // A malformed form body is a wrong token.
    }
    const code = form?.get("code");
    if (typeof code === "string") {
      try {
        if (!(await codeWorks(code))) return seeOther(request, "/console/unlock?error=code");
      } catch (err) {
        console.error("[frontdesk/owner-session] checking a code failed", err);
        return seeOther(request, "/console/unlock?error=code");
      }
      return seeOther(request, "/console", { "set-cookie": cookie().header });
    }
    const given = form?.get("token");
    if (typeof given !== "string" || !ownerTokenMatches(given, configured)) return seeOther(request, "/console/unlock?error=1");
    return seeOther(request, "/console", { "set-cookie": cookie().header });
  }

  if (configuredOwnerToken(configured) === "") {
    const failure = ownerUnauthorized("Owner access isn't set up on this deployment.", NOT_SET_UP_NEXT_ACTION);
    return json(failure.body, failure.status, failure.headers);
  }
  let given: Credential;
  try {
    given = readCredential(await request.text());
    if ("code" in given) {
      if (!(await codeWorks(given.code))) {
        const failure = ownerUnauthorized("Wrong or expired code, or it was already used.", WRONG_CODE_NEXT_ACTION);
        return json(failure.body, failure.status, failure.headers);
      }
      const { expiresAtS, header } = cookie();
      return json({ signedIn: true, expiresAt: rfc3339(expiresAtS) }, 200, { "set-cookie": header });
    }
  } catch (err) {
    return errorResponse(err);
  }
  if (!ownerTokenMatches(given.token, configured)) {
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
