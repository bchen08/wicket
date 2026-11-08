import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, BookingsResponse, OwnerSessionRequest, OwnerSessionResponse, PoliciesResponse } from "../../types/frontdesk";
import { bookingsResponse, policiesGet, policiesPut, type OwnerOptions } from "./http";
import { NOT_SET_UP_NEXT_ACTION, OWNER_SESSION_COOKIE, UNLOCK_NEXT_ACTION } from "./owner-auth";
import { ownerSessionDelete, ownerSessionGet, ownerSessionPost, type OwnerSessionOptions } from "./owner-session";
import { memoryDeps } from "./test-support";

// The stub owner session: POST, GET and DELETE /api/owner/session through the handlers the route file
// calls, and the fd_owner cookie it sets used on real owner routes (policies, the bookings list).
// TODO(ring-2): owner sign-in by texted code replaces this.

const TOKEN = "owner-token-for-tests-0123456789";
const LOCAL = "http://localhost:3000";
const DEPLOYED = "https://front-desk-git-branch.vercel.app";
const NOW_MS = Date.parse("2026-11-07T22:00:00Z");
const EXPIRES_AT = "2026-11-08T10:00:00Z"; // NOW + 12 hours

afterEach(() => {
  vi.unstubAllEnvs();
});

function options(extra: OwnerSessionOptions = {}): OwnerSessionOptions {
  return { getToken: () => TOKEN, now: () => NOW_MS, ...extra };
}

function sessionRequest(
  method: "POST" | "GET" | "DELETE",
  init: { origin?: string; body?: unknown; raw?: string; form?: Record<string, string>; cookie?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.form !== undefined) {
    body = new URLSearchParams(init.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`${init.origin ?? LOCAL}/api/owner/session`, { method, headers, body });
}

const signIn = (token: string, opts = options(), init: { origin?: string } = {}) =>
  ownerSessionPost(sessionRequest("POST", { ...init, body: { token } satisfies OwnerSessionRequest }), opts);

const formSignIn = (form: Record<string, string>, opts = options(), init: { origin?: string } = {}) =>
  ownerSessionPost(sessionRequest("POST", { ...init, form }), opts);

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

describe("POST /api/owner/session (JSON)", () => {
  it("with the right token: 200 { signedIn: true, expiresAt } and an HttpOnly, SameSite=Lax, 12-hour cookie holding the token", async () => {
    const res = await signIn(TOKEN);
    expect(await json<OwnerSessionResponse>(res, 200)).toEqual({ signedIn: true, expiresAt: EXPIRES_AT });

    const [pair, ...attributes] = setCookieParts(res);
    expect(pair).toBe(`${OWNER_SESSION_COOKIE}=${TOKEN}`);
    expect(attributes).toEqual(["Path=/", "Max-Age=43200", "HttpOnly", "SameSite=Lax"]);
  });

  it("stores the configured token, trimmed and URI-encoded", async () => {
    const odd = "code; with=odd,chars";
    const res = await signIn(odd, options({ getToken: () => ` ${odd}\n` }));
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).toBe(`${OWNER_SESSION_COOKIE}=${encodeURIComponent(odd)}`);
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

  it("always marks the cookie Secure on Vercel, whatever request.url says", async () => {
    vi.stubEnv("VERCEL", "1");
    expect(setCookieParts(await signIn(TOKEN)).includes("Secure")).toBe(true);
    expect(setCookieParts(await formSignIn({ token: TOKEN })).includes("Secure")).toBe(true);
    expect(setCookieParts(ownerSessionDelete(sessionRequest("DELETE"))).includes("Secure")).toBe(true);
  });

  it("trims the token, like the bearer check", async () => {
    expect((await signIn(`  ${TOKEN}\n`)).status).toBe(200);
  });

  it.each([
    ["a wrong token", "x".repeat(TOKEN.length)],
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
    ["unset", undefined],
    ["empty", ""],
    ["blank", "  "],
  ])("is 401 with the set-up next_action, and no cookie, when OWNER_API_TOKEN is %s", async (_name, configured) => {
    for (const token of [TOKEN, "", "  "]) {
      const res = await signIn(token, options({ getToken: () => configured }));
      const body = await json<ApiError>(res, 401);
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.next_action).toBe(NOT_SET_UP_NEXT_ACTION);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
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
    const opts = { now: () => NOW_MS };
    vi.stubEnv("OWNER_API_TOKEN", TOKEN);
    expect((await signIn(TOKEN, opts)).status).toBe(200);
    vi.stubEnv("OWNER_API_TOKEN", "");
    expect((await signIn(TOKEN, opts)).status).toBe(401);
  });
});

describe("POST /api/owner/session (form post from /console/unlock)", () => {
  it("with the right token: 303 → /console, setting the cookie", async () => {
    const res = await formSignIn({ token: TOKEN });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${LOCAL}/console`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(setCookieParts(res)).toEqual([`${OWNER_SESSION_COOKIE}=${TOKEN}`, "Path=/", "Max-Age=43200", "HttpOnly", "SameSite=Lax"]);
  });

  it("redirects on the request's origin", async () => {
    const res = await formSignIn({ token: TOKEN }, options(), { origin: DEPLOYED });
    expect(res.headers.get("location")).toBe(`${DEPLOYED}/console`);
    expect(setCookieParts(res)).toContain("Secure");
  });

  it("trims the token", async () => {
    expect((await formSignIn({ token: `  ${TOKEN} ` })).headers.get("location")).toBe(`${LOCAL}/console`);
  });

  it.each([
    ["a wrong token", { token: "wrong" }],
    ["an empty token", { token: "" }],
    // (A `code` field is a texted code: see texting.test.ts.)
    ["no token field", { password: TOKEN }],
  ])("with %s: 303 → /console/unlock?error=1 and no cookie", async (_name, form) => {
    const res = await formSignIn(form);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${LOCAL}/console/unlock?error=1`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("is a wrong token when OWNER_API_TOKEN isn't set", async () => {
    for (const configured of [undefined, ""]) {
      const res = await formSignIn({ token: "" }, options({ getToken: () => configured }));
      expect(res.headers.get("location")).toBe(`${LOCAL}/console/unlock?error=1`);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("accepts multipart/form-data too", async () => {
    const form = new FormData();
    form.set("token", TOKEN);
    const res = await ownerSessionPost(new Request(`${LOCAL}/api/owner/session`, { method: "POST", body: form }), options());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${LOCAL}/console`);
  });
});

describe("GET /api/owner/session", () => {
  it("is { signedIn: false } without a cookie", async () => {
    expect(await json<OwnerSessionResponse>(ownerSessionGet(sessionRequest("GET"), options()), 200)).toEqual({
      signedIn: false,
    });
  });

  it("is { signedIn: true } with the cookie POST set", async () => {
    const cookie = cookieFrom(await signIn(TOKEN));
    expect(await json<OwnerSessionResponse>(ownerSessionGet(sessionRequest("GET", { cookie }), options()), 200)).toEqual({
      signedIn: true,
    });
  });

  it("is { signedIn: false } with a wrong cookie, after OWNER_API_TOKEN changes, or when it isn't set", async () => {
    const cookie = cookieFrom(await signIn(TOKEN));
    expect(await json(ownerSessionGet(sessionRequest("GET", { cookie: `${OWNER_SESSION_COOKIE}=wrong` }), options()), 200)).toEqual({
      signedIn: false,
    });
    const rotated = options({ getToken: () => "rotated-owner-token" });
    expect(await json(ownerSessionGet(sessionRequest("GET", { cookie }), rotated), 200)).toEqual({ signedIn: false });
    const unset = options({ getToken: () => undefined });
    expect(await json(ownerSessionGet(sessionRequest("GET", { cookie: `${OWNER_SESSION_COOKIE}=` }), unset), 200)).toEqual({
      signedIn: false,
    });
  });
});

describe("DELETE /api/owner/session", () => {
  it("is { signedIn: false } and clears the cookie with the same attributes", async () => {
    const res = ownerSessionDelete(sessionRequest("DELETE", { cookie: cookieFrom(await signIn(TOKEN)) }));
    expect(await json<OwnerSessionResponse>(res, 200)).toEqual({ signedIn: false });
    expect(setCookieParts(res)).toEqual([`${OWNER_SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]);
  });

  it("clears a Secure cookie with Secure", () => {
    const res = ownerSessionDelete(sessionRequest("DELETE", { origin: DEPLOYED }));
    expect(setCookieParts(res)).toContain("Secure");
    expect(setCookieParts(res)).toContain("Max-Age=0");
  });
});

// ---- The cookie on owner routes ----

describe("the fd_owner cookie on owner routes", () => {
  const OWNER: OwnerOptions = { getToken: () => TOKEN };

  function ownerRequest(path: string, method: "GET" | "PUT", init: { cookie?: string; bearer?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (init.cookie !== undefined) headers.cookie = init.cookie;
    if (init.bearer) headers.authorization = `Bearer ${TOKEN}`;
    let body: string | undefined;
    if (method === "PUT") {
      body = JSON.stringify({ leadTimeMin: 60 });
      headers["content-type"] = "application/json";
    }
    return new Request(`${DEPLOYED}${path}`, { method, headers, body });
  }
  const policies = (method: "GET" | "PUT", init: { cookie?: string; bearer?: boolean } = {}) =>
    ownerRequest("/api/shops/harts/policies", method, init);

  async function realCookie(): Promise<string> {
    return cookieFrom(await signIn(TOKEN, options(), { origin: DEPLOYED }));
  }

  it("accepts the cookie on a read (GET)", async () => {
    const body = await json<PoliciesResponse>(await policiesGet(() => memoryDeps(), policies("GET", { cookie: await realCookie() }), "harts", OWNER), 200);
    expect(body.shop.slug).toBe("harts");
  });

  it("accepts the cookie on a write (PUT), and applies it", async () => {
    const deps = memoryDeps();
    const res = await policiesPut(() => deps, policies("PUT", { cookie: await realCookie() }), "harts", OWNER);
    expect((await json<PoliciesResponse>(res, 200)).policies.leadTimeMin).toBe(60);
  });

  it("still accepts Bearer", async () => {
    const res = await policiesPut(() => memoryDeps(), policies("PUT", { bearer: true }), "harts", OWNER);
    expect((await json<PoliciesResponse>(res, 200)).policies.leadTimeMin).toBe(60);
  });

  it("rejects a wrong cookie with 401 unauthorized, before touching the database", async () => {
    const getDeps = vi.fn(() => memoryDeps());
    const res = await policiesGet(getDeps, policies("GET", { cookie: `${OWNER_SESSION_COOKIE}=wrong` }), "harts", OWNER);
    expect((await json<ApiError>(res, 401)).error.code).toBe("unauthorized");
    expect(getDeps).not.toHaveBeenCalled();
  });

  it("the bookings list accepts the cookie, and without it says to unlock the console", async () => {
    const bookings = (cookie?: string) => bookingsResponse(() => memoryDeps(), ownerRequest("/api/shops/harts/bookings", "GET", { cookie }), "harts", OWNER);
    expect((await json<BookingsResponse>(await bookings(await realCookie()), 200)).shop.slug).toBe("harts");
    const refused = await json<ApiError>(await bookings(), 401);
    expect(refused.error.code).toBe("unauthorized");
    expect(refused.error.next_action).toBe(UNLOCK_NEXT_ACTION);
  });

  it("sign in (form) → read → sign out → refused, with a browser-like cookie jar", async () => {
    let jar: string | undefined;
    const keep = (res: Response) => {
      const [pair, ...attributes] = setCookieParts(res);
      jar = attributes.includes("Max-Age=0") ? undefined : pair;
    };

    keep(await formSignIn({ token: TOKEN }, options(), { origin: DEPLOYED }));
    expect((await policiesGet(() => memoryDeps(), policies("GET", { cookie: jar }), "harts", OWNER)).status).toBe(200);

    keep(ownerSessionDelete(sessionRequest("DELETE", { origin: DEPLOYED, cookie: jar })));
    expect(jar).toBeUndefined();
    expect((await policiesGet(() => memoryDeps(), policies("GET", { cookie: jar }), "harts", OWNER)).status).toBe(401);
  });
});
