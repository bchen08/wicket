import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, OwnerSessionRequest, OwnerSessionResponse, PoliciesResponse } from "../../types/frontdesk";
import { policiesGet, policiesPut, type OwnerOptions } from "./http";
import { OWNER_SESSION_COOKIE, OWNER_SESSION_MAX_AGE_S, ownerSessionValue } from "./owner-auth";
import {
  clientIp,
  createAttemptLimiter,
  ownerSessionDelete,
  ownerSessionGet,
  ownerSessionPost,
  SESSION_ATTEMPT_LIMIT,
  SESSION_ATTEMPT_WINDOW_MS,
  type OwnerSessionOptions,
} from "./owner-session";
import { memoryDeps } from "./test-support";

// The stub owner session: POST, GET and DELETE /api/owner/session through the handlers the route file
// calls, and the fd_owner cookie it sets used on a real owner route (policies).
// TODO(ring-2): owner sign-in by texted code replaces this.

const TOKEN = "owner-token-for-tests-0123456789";
const LOCAL = "http://localhost:3000";
const DEPLOYED = "https://front-desk-git-branch.vercel.app";
const NOW_MS = Date.parse("2026-11-07T22:00:00Z");
const EXPIRES_AT = "2026-11-08T10:00:00Z"; // NOW + 12 hours

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Fresh limiter per test, so tests don't share attempt counts. */
function options(extra: OwnerSessionOptions = {}): OwnerSessionOptions {
  return { getToken: () => TOKEN, now: () => NOW_MS, limiter: createAttemptLimiter(), ...extra };
}

function sessionRequest(
  method: "POST" | "GET" | "DELETE",
  init: { origin?: string; body?: unknown; raw?: string; cookie?: string; ip?: string } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-for": init.ip ?? "203.0.113.7" };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`${init.origin ?? LOCAL}/api/owner/session`, { method, headers, body });
}

const signIn = (token: string, opts = options(), init: { origin?: string; ip?: string } = {}) =>
  ownerSessionPost(sessionRequest("POST", { ...init, body: { token } satisfies OwnerSessionRequest }), opts);

/** The Set-Cookie attributes, split on "; ", with the name=value first. */
function setCookieParts(res: Response): string[] {
  const header = res.headers.get("set-cookie");
  expect(header).not.toBeNull();
  return header!.split("; ");
}

/** The "fd_owner=<value>" pair a browser would send back. */
function cookieFrom(res: Response): string {
  return setCookieParts(res)[0];
}

async function json<T>(res: Response, status: number): Promise<T> {
  const body = (await res.json()) as T;
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return body;
}

describe("POST /api/owner/session", () => {
  it("with the right token: 200 { signedIn: true, expiresAt } and an HttpOnly, SameSite=Strict, 12-hour cookie", async () => {
    const res = await signIn(TOKEN);
    expect(await json<OwnerSessionResponse>(res, 200)).toEqual({ signedIn: true, expiresAt: EXPIRES_AT });

    const [pair, ...attributes] = setCookieParts(res);
    expect(pair).toBe(`${OWNER_SESSION_COOKIE}=${ownerSessionValue(TOKEN, NOW_MS / 1000 + OWNER_SESSION_MAX_AGE_S)}`);
    expect(attributes).toEqual(["Path=/", "Max-Age=43200", "HttpOnly", "SameSite=Strict"]);
  });

  it("never puts the token in the cookie or the body", async () => {
    const res = await signIn(TOKEN);
    expect(res.headers.get("set-cookie")).not.toContain(TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("marks the cookie Secure everywhere except http on localhost", async () => {
    const secure = async (origin: string) => setCookieParts(await signIn(TOKEN, options(), { origin })).includes("Secure");
    expect(await secure(DEPLOYED)).toBe(true);
    expect(await secure("https://localhost:3000")).toBe(true);
    expect(await secure("http://192.168.1.20:3000")).toBe(true);
    expect(await secure("http://localhost.evil.example")).toBe(true);
    expect(await secure(LOCAL)).toBe(false);
    expect(await secure("http://127.0.0.1:3000")).toBe(false);
    expect(await secure("http://[::1]:3000")).toBe(false);
  });

  it("decides Secure from the origin the browser used (forwarding headers), not Next's internal request.url", async () => {
    // Next.js gives routes http://localhost:<port> as request.url whatever the browser used.
    const secure = async (headers: Record<string, string>) => {
      const req = new Request(`${LOCAL}/api/owner/session`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7", "content-type": "application/json", ...headers },
        body: JSON.stringify({ token: TOKEN }),
      });
      return setCookieParts(await ownerSessionPost(req, options())).includes("Secure");
    };
    expect(await secure({ "x-forwarded-host": "front-desk.vercel.app", "x-forwarded-proto": "https" })).toBe(true);
    expect(await secure({ "x-forwarded-host": "192.168.1.20:3000", "x-forwarded-proto": "http" })).toBe(true);
    expect(await secure({ "x-forwarded-host": "evil.example/x", "x-forwarded-proto": "http" })).toBe(true);
    expect(await secure({ "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" })).toBe(false);
    expect(await secure({ "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" })).toBe(false);
  });

  it("trims the token, like the bearer check", async () => {
    expect((await signIn(`  ${TOKEN}\n`)).status).toBe(200);
  });

  it.each([
    ["a wrong token of the same length", "x".repeat(TOKEN.length)],
    ["a prefix of the token", TOKEN.slice(0, -1)],
    ["the token in different case", TOKEN.toUpperCase()],
    ["an empty token", ""],
    ["a token of only spaces", "   "],
  ])("with %s: 401 unauthorized, a WWW-Authenticate challenge and no cookie", async (_name, token) => {
    const res = await signIn(token);
    const body = await json<ApiError>(res, 401);
    expect(body.error).toEqual({
      code: "unauthorized",
      message: "Wrong owner token.",
      next_action: 'Check the deployment\'s OWNER_API_TOKEN, then send it again as { "token": "…" }.',
    });
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="front-desk-owner"');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it.each([
    ["unset", undefined, /not set/],
    ["blank", "  ", /not set/],
    ["too short", "short-token", /too short/],
  ])("is 503 internal, with no cookie, when OWNER_API_TOKEN is %s", async (_name, configured, message) => {
    const res = await signIn(TOKEN, options({ getToken: () => configured }));
    const body = await json<ApiError>(res, 503);
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toMatch(message);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    ["an empty body", { raw: "" }, "body", "The request body is empty."],
    ["invalid JSON", { raw: "{token" }, "body", "The request body isn't valid JSON."],
    ["a JSON array", { body: [TOKEN] }, "body", "The request body must be a JSON object."],
    ["no token field", { body: {} }, "token", "token must be a string: the OWNER_API_TOKEN."],
    ["a numeric token", { body: { token: 123 } }, "token", "token must be a string: the OWNER_API_TOKEN."],
  ])("with %s: 400 invalid_request naming the field", async (_name, init, field, message) => {
    const res = await ownerSessionPost(sessionRequest("POST", init), options());
    const body = await json<ApiError>(res, 400);
    expect(body.error).toEqual({
      code: "invalid_request",
      message,
      next_action: 'Send a JSON object { "token": "<OWNER_API_TOKEN>" } as the request body.',
      details: { field, issues: [{ path: field, message }] },
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("reads OWNER_API_TOKEN from the environment by default", async () => {
    const opts = { now: () => NOW_MS, limiter: createAttemptLimiter() };
    vi.stubEnv("OWNER_API_TOKEN", TOKEN);
    expect((await signIn(TOKEN, opts)).status).toBe(200);
    vi.stubEnv("OWNER_API_TOKEN", "");
    expect((await signIn(TOKEN, opts)).status).toBe(503);
  });
});

describe("POST /api/owner/session: rate limit (10 attempts per IP per 15 minutes)", () => {
  it(`refuses the ${SESSION_ATTEMPT_LIMIT + 1}th attempt from one IP with 429 and Retry-After, even with the right token`, async () => {
    let now = NOW_MS;
    const opts = options({ now: () => now });
    for (let i = 0; i < SESSION_ATTEMPT_LIMIT; i++) {
      now = NOW_MS + i * 1000; // one attempt a second
      expect((await signIn(`wrong-token-number-${i}-padding`, opts)).status).toBe(401);
    }

    now = NOW_MS + SESSION_ATTEMPT_LIMIT * 1000;
    const res = await signIn(TOKEN, opts);
    const body = await json<ApiError>(res, 429);
    // The first attempt leaves the window 15 minutes after it was made: 890 seconds from now.
    const retryAfter = SESSION_ATTEMPT_WINDOW_MS / 1000 - SESSION_ATTEMPT_LIMIT;
    expect(res.headers.get("retry-after")).toBe(String(retryAfter));
    expect(body.error).toEqual({
      code: "invalid_request",
      message: "Too many sign-in attempts from this address: at most 10 per 15 minutes.",
      next_action: "Wait 15 minute(s) (details.retryAfter seconds), then try again.",
      details: { retryAfter },
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("counts successful attempts too, and per IP: another address can still sign in", async () => {
    const opts = options();
    for (let i = 0; i < SESSION_ATTEMPT_LIMIT; i++) expect((await signIn(TOKEN, opts)).status).toBe(200);
    expect((await signIn(TOKEN, opts)).status).toBe(429);
    expect((await signIn(TOKEN, opts, { ip: "198.51.100.9" })).status).toBe(200);
  });

  it("allows attempts again as old ones leave the 15-minute window; refused attempts aren't counted", async () => {
    let now = NOW_MS;
    const opts = options({ now: () => now });
    for (let i = 0; i < SESSION_ATTEMPT_LIMIT; i++) await signIn("wrong-token-of-some-length", opts);
    // Hammering while blocked doesn't extend the block.
    for (let i = 0; i < 5; i++) expect((await signIn(TOKEN, opts)).status).toBe(429);

    now = NOW_MS + SESSION_ATTEMPT_WINDOW_MS - 1;
    expect((await signIn(TOKEN, opts)).status).toBe(429);
    now = NOW_MS + SESSION_ATTEMPT_WINDOW_MS;
    expect((await signIn(TOKEN, opts)).status).toBe(200);
  });

  it("keys on the first X-Forwarded-For address, then X-Real-IP", () => {
    const req = (headers: Record<string, string>) => new Request(`${LOCAL}/api/owner/session`, { headers });
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("forgets the least recently seen addresses beyond its capacity", () => {
    const limiter = createAttemptLimiter(1, SESSION_ATTEMPT_WINDOW_MS, 2);
    expect(limiter.attempt("a", NOW_MS)).toBe(0);
    expect(limiter.attempt("b", NOW_MS)).toBe(0);
    expect(limiter.attempt("a", NOW_MS)).toBeGreaterThan(0); // a is now the most recently seen
    expect(limiter.attempt("c", NOW_MS)).toBe(0); // evicts b
    expect(limiter.attempt("b", NOW_MS)).toBe(0);
    expect(limiter.attempt("c", NOW_MS)).toBeGreaterThan(0);
  });
});

describe("GET /api/owner/session", () => {
  it("is { signedIn: false } without a cookie", async () => {
    expect(await json<OwnerSessionResponse>(ownerSessionGet(sessionRequest("GET"), options()), 200)).toEqual({
      signedIn: false,
    });
  });

  it("is { signedIn: true, expiresAt } with the cookie POST set, until it expires", async () => {
    const cookie = cookieFrom(await signIn(TOKEN));
    const get = (nowMs: number) => ownerSessionGet(sessionRequest("GET", { cookie }), options({ now: () => nowMs }));
    expect(await json<OwnerSessionResponse>(get(NOW_MS + 60_000), 200)).toEqual({ signedIn: true, expiresAt: EXPIRES_AT });
    expect(await json<OwnerSessionResponse>(get(Date.parse(EXPIRES_AT)), 200)).toEqual({ signedIn: false });
  });

  it("is { signedIn: false } with a tampered cookie, or after OWNER_API_TOKEN changes", async () => {
    const cookie = cookieFrom(await signIn(TOKEN));
    const [name, value] = cookie.split("=");
    const [expiry, signature] = value.split(".");
    const tampered = `${name}=${Number(expiry) + 3600}.${signature}`;
    expect(await json(ownerSessionGet(sessionRequest("GET", { cookie: tampered }), options()), 200)).toEqual({
      signedIn: false,
    });
    const rotated = options({ getToken: () => "rotated-owner-token-0123456789" });
    expect(await json(ownerSessionGet(sessionRequest("GET", { cookie }), rotated), 200)).toEqual({ signedIn: false });
  });

  it("is 503 when OWNER_API_TOKEN is unset, so the console can say so instead of offering a sign-in", async () => {
    const body = await json<ApiError>(ownerSessionGet(sessionRequest("GET"), options({ getToken: () => undefined })), 503);
    expect(body.error.code).toBe("internal");
  });
});

describe("DELETE /api/owner/session", () => {
  it("is { signedIn: false } and clears the cookie with the same attributes", async () => {
    const res = ownerSessionDelete(sessionRequest("DELETE", { cookie: cookieFrom(await signIn(TOKEN)) }));
    expect(await json<OwnerSessionResponse>(res, 200)).toEqual({ signedIn: false });
    expect(setCookieParts(res)).toEqual([`${OWNER_SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Strict"]);
  });

  it("clears a Secure cookie with Secure", () => {
    const res = ownerSessionDelete(sessionRequest("DELETE", { origin: DEPLOYED }));
    expect(setCookieParts(res)).toContain("Secure");
    expect(setCookieParts(res)).toContain("Max-Age=0");
  });
});

// ---- The cookie on an owner route ----

describe("the fd_owner cookie on an owner route (policies)", () => {
  const OWNER: OwnerOptions = { getToken: () => TOKEN };

  function policies(method: "GET" | "PUT", init: { cookie?: string; origin?: string | null; bearer?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (init.cookie !== undefined) headers.cookie = init.cookie;
    if (init.origin !== undefined && init.origin !== null) headers.origin = init.origin;
    if (init.bearer) headers.authorization = `Bearer ${TOKEN}`;
    let body: string | undefined;
    if (method === "PUT") {
      body = JSON.stringify({ leadTimeMin: 60 });
      headers["content-type"] = "application/json";
    }
    return new Request(`${DEPLOYED}/api/shops/harts/policies`, { method, headers, body });
  }

  /** A real cookie from POST /api/owner/session, on the wall clock the owner routes check against. */
  async function realCookie(): Promise<string> {
    return cookieFrom(await signIn(TOKEN, options({ now: Date.now }), { origin: DEPLOYED }));
  }

  it("accepts the cookie on a read (GET), with no Origin header", async () => {
    const body = await json<PoliciesResponse>(await policiesGet(() => memoryDeps(), policies("GET", { cookie: await realCookie() }), "harts", OWNER), 200);
    expect(body.shop.slug).toBe("harts");
  });

  it("accepts a same-origin write (PUT) with the cookie, and applies it", async () => {
    const deps = memoryDeps();
    const res = await policiesPut(() => deps, policies("PUT", { cookie: await realCookie(), origin: DEPLOYED }), "harts", OWNER);
    expect((await json<PoliciesResponse>(res, 200)).policies.leadTimeMin).toBe(60);
  });

  it("rejects a cross-origin write, or one with no Origin, with 403 before touching the shop", async () => {
    const cookie = await realCookie();
    for (const origin of ["https://evil.example", null]) {
      const getDeps = vi.fn(() => memoryDeps());
      const body = await json<ApiError>(await policiesPut(getDeps, policies("PUT", { cookie, origin }), "harts", OWNER), 403);
      expect(body.error.code).toBe("invalid_request");
      expect(getDeps).not.toHaveBeenCalled();
    }
  });

  it("still accepts Bearer, for writes from any origin", async () => {
    const res = await policiesPut(() => memoryDeps(), policies("PUT", { bearer: true, origin: "https://evil.example" }), "harts", OWNER);
    expect((await json<PoliciesResponse>(res, 200)).policies.leadTimeMin).toBe(60);
  });

  it("rejects an expired or tampered cookie with 401 unauthorized", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const valid = ownerSessionValue(TOKEN, nowS + 3600);
    const [expiry, signature] = valid.split(".");
    for (const value of [
      ownerSessionValue(TOKEN, nowS - 1), // expired
      `${Number(expiry) + 3600}.${signature}`, // expiry pushed out, old signature
      ownerSessionValue("someone-elses-token-0123456789", nowS + 3600), // signed with another key
    ]) {
      const getDeps = vi.fn(() => memoryDeps());
      const res = await policiesGet(getDeps, policies("GET", { cookie: `${OWNER_SESSION_COOKIE}=${value}` }), "harts", OWNER);
      expect((await json<ApiError>(res, 401)).error.code).toBe("unauthorized");
      expect(getDeps).not.toHaveBeenCalled();
    }
  });

  it("sign in → read → sign out → refused, with a browser-like cookie jar", async () => {
    let jar: string | undefined;
    const keep = (res: Response) => {
      const [pair, ...attributes] = setCookieParts(res);
      jar = attributes.includes("Max-Age=0") ? undefined : pair;
    };

    keep(await signIn(TOKEN, options({ now: Date.now }), { origin: DEPLOYED }));
    expect((await policiesGet(() => memoryDeps(), policies("GET", { cookie: jar }), "harts", OWNER)).status).toBe(200);

    keep(ownerSessionDelete(sessionRequest("DELETE", { origin: DEPLOYED, cookie: jar })));
    expect(jar).toBeUndefined();
    expect((await policiesGet(() => memoryDeps(), policies("GET", { cookie: jar }), "harts", OWNER)).status).toBe(401);
  });
});
