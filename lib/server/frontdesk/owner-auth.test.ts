import { describe, expect, it } from "vitest";
import {
  checkOwnerAuth,
  MIN_OWNER_TOKEN_LENGTH,
  OWNER_AUTH_CHALLENGE,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_MAX_AGE_S,
  ownerSessionValue,
  requestOrigin,
} from "./owner-auth";

// The stub owner auth: Authorization: Bearer <OWNER_API_TOKEN>, compared in constant time, or the
// fd_owner session cookie. TODO(ring-2): owner sign-in by texted code replaces both.

const TOKEN = "owner-token-for-tests-0123456789";

function request(authorization?: string): Request {
  return new Request("http://localhost/api/shops/harts/policies", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("checkOwnerAuth: a configured token", () => {
  it.each([
    ["the exact token", `Bearer ${TOKEN}`],
    ['a lowercase "bearer" scheme', `bearer ${TOKEN}`],
    ["an uppercase scheme", `BEARER ${TOKEN}`],
    ["several spaces after the scheme", `Bearer    ${TOKEN}`],
    ["spaces around the token", `Bearer   ${TOKEN}   `],
  ])("accepts %s", (_name, header) => {
    expect(checkOwnerAuth(request(header), TOKEN)).toEqual({ ok: true });
  });

  it("trims the configured token too (e.g. a trailing newline in the env var)", () => {
    expect(checkOwnerAuth(request(`Bearer ${TOKEN}`), `  ${TOKEN}\n`)).toEqual({ ok: true });
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty Authorization header", ""],
    ["another scheme", `Basic ${TOKEN}`],
    ["the token without a scheme", TOKEN],
    ["the scheme without a space", `Bearer${TOKEN}`],
    ["an empty token", "Bearer "],
    ["a token of only spaces", "Bearer      "],
    ["a wrong token of the same length", `Bearer ${"x".repeat(TOKEN.length)}`],
    ["a wrong token of a different length", "Bearer short-wrong-token"],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["the token plus extra characters", `Bearer ${TOKEN}x`],
    ["the token in different case", `Bearer ${TOKEN.toUpperCase()}`],
  ])("rejects %s with 401 unauthorized and a WWW-Authenticate challenge", (_name, header) => {
    const result = checkOwnerAuth(request(header), TOKEN);
    expect(result).toEqual({
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
    });
    expect(OWNER_AUTH_CHALLENGE).toBe('Bearer realm="front-desk-owner"');
    // The configured token is never echoed back.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("never echoes the token that was sent", () => {
    const sent = "wrong-token-that-must-not-leak-42";
    expect(JSON.stringify(checkOwnerAuth(request(`Bearer ${sent}`), TOKEN))).not.toContain(sent);
  });
});

describe("checkOwnerAuth: no usable configured token (never open)", () => {
  const configure =
    "Set OWNER_API_TOKEN (at least 16 random characters) in the deployment's environment variables, then redeploy.";

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   \n"],
  ])("is 503 internal when OWNER_API_TOKEN is %s, even with a header", (_name, configured) => {
    for (const header of [undefined, "Bearer ", `Bearer ${TOKEN}`]) {
      const result = checkOwnerAuth(request(header), configured);
      expect(result).toEqual({
        ok: false,
        status: 503,
        body: {
          error: {
            code: "internal",
            message: "The owner API is not configured on this deployment: OWNER_API_TOKEN is not set.",
            next_action: configure,
          },
        },
        headers: {},
      });
    }
  });

  it(`is 503 internal when OWNER_API_TOKEN is shorter than ${MIN_OWNER_TOKEN_LENGTH} characters after trimming`, () => {
    const short = "a".repeat(MIN_OWNER_TOKEN_LENGTH - 1);
    for (const configured of [short, `  ${short}  `]) {
      // Even the matching token is refused: a short token is treated as not configured.
      const result = checkOwnerAuth(request(`Bearer ${short}`), configured);
      expect(result).toEqual({
        ok: false,
        status: 503,
        body: {
          error: {
            code: "internal",
            message:
              "The owner API is not configured on this deployment: OWNER_API_TOKEN is too short (at least 16 characters).",
            next_action: configure,
          },
        },
        headers: {},
      });
      expect(JSON.stringify(result)).not.toContain(short);
    }
  });

  it(`accepts a token of exactly ${MIN_OWNER_TOKEN_LENGTH} characters`, () => {
    const exact = "b".repeat(MIN_OWNER_TOKEN_LENGTH);
    expect(checkOwnerAuth(request(`Bearer ${exact}`), exact)).toEqual({ ok: true });
  });
});

// ---- The owner session cookie (fd_owner), set by POST /api/owner/session ----

describe("checkOwnerAuth: the fd_owner session cookie", () => {
  const ORIGIN = "https://front-desk.example";
  const NOW_MS = Date.parse("2026-11-07T22:00:00Z");
  const NOW_S = NOW_MS / 1000;
  /** A session that ends in 12 hours. */
  const VALID = ownerSessionValue(TOKEN, NOW_S + OWNER_SESSION_MAX_AGE_S);

  function withCookie(
    cookie: string | undefined,
    init: { method?: string; origin?: string | null; authorization?: string } = {},
  ): Request {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers.cookie = cookie;
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (origin !== null) headers.origin = origin;
    if (init.authorization !== undefined) headers.authorization = init.authorization;
    return new Request(`${ORIGIN}/api/shops/harts/policies`, { method: init.method ?? "GET", headers });
  }

  const check = (request: Request, nowMs = NOW_MS) => checkOwnerAuth(request, TOKEN, nowMs);

  it("signs the expiry, not the token: the value is '<expiry>.<HMAC-SHA256>' and never contains the token", () => {
    expect(VALID).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(VALID.split(".")[0]).toBe(String(NOW_S + OWNER_SESSION_MAX_AGE_S));
    expect(VALID).not.toContain(TOKEN);
    // The same expiry signed with another token is a different value.
    expect(ownerSessionValue("another-owner-token-0123456789", NOW_S + OWNER_SESSION_MAX_AGE_S)).not.toBe(VALID);
  });

  it.each(["GET", "HEAD"])("accepts a valid cookie on %s, with or without an Origin header", (method) => {
    expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`, { method }))).toEqual({ ok: true });
    expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`, { method, origin: null }))).toEqual({ ok: true });
    expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`, { method, origin: "https://evil.example" }))).toEqual({
      ok: true,
    });
  });

  it("finds the cookie among others, and accepts it when any fd_owner value is valid", () => {
    expect(check(withCookie(`theme=dark; ${OWNER_SESSION_COOKIE}=${VALID}; other=1`))).toEqual({ ok: true });
    expect(check(withCookie(`${OWNER_SESSION_COOKIE}=stale; ${OWNER_SESSION_COOKIE}=${VALID}`))).toEqual({ ok: true });
  });

  it("accepts it up to the last millisecond before the expiry", () => {
    expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`), (NOW_S + OWNER_SESSION_MAX_AGE_S) * 1000 - 1)).toEqual({
      ok: true,
    });
  });

  const expired = ownerSessionValue(TOKEN, NOW_S - 1);
  const [validExpiry, validSignature] = VALID.split(".");
  const flipped = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);

  it.each([
    ["an expired cookie", `${OWNER_SESSION_COOKIE}=${expired}`],
    ["a cookie that expires exactly now", `${OWNER_SESSION_COOKIE}=${ownerSessionValue(TOKEN, NOW_S)}`],
    ["an extended expiry with the old signature", `${OWNER_SESSION_COOKIE}=${Number(validExpiry) + 3600}.${validSignature}`],
    ["an expired cookie's signature on a later expiry", `${OWNER_SESSION_COOKIE}=${validExpiry}.${expired.split(".")[1]}`],
    ["one changed signature character", `${OWNER_SESSION_COOKIE}=${validExpiry}.${flipped(validSignature)}`],
    ["a non-canonical expiry (leading zero)", `${OWNER_SESSION_COOKIE}=0${VALID}`],
    ["a signature made with another token", `${OWNER_SESSION_COOKIE}=${ownerSessionValue("rotated-owner-token-0123456789", Number(validExpiry))}`],
    ["the token itself as the value", `${OWNER_SESSION_COOKIE}=${TOKEN}`],
    ["the expiry alone", `${OWNER_SESSION_COOKIE}=${validExpiry}`],
    ["the signature alone", `${OWNER_SESSION_COOKIE}=${validSignature}`],
    ["an empty value", `${OWNER_SESSION_COOKIE}=`],
    ["a valid value under another name", `fd_owner_x=${VALID}`],
    ["no cookie at all", undefined],
  ])("rejects %s with 401 unauthorized", (_name, cookie) => {
    expect(check(withCookie(cookie))).toMatchObject({
      ok: false,
      status: 401,
      body: { error: { code: "unauthorized" } },
      headers: { "www-authenticate": OWNER_AUTH_CHALLENGE },
    });
  });

  it("ends every session when OWNER_API_TOKEN changes", () => {
    const request = withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`);
    expect(checkOwnerAuth(request, TOKEN, NOW_MS)).toEqual({ ok: true });
    expect(checkOwnerAuth(request, "rotated-owner-token-0123456789", NOW_MS)).toMatchObject({ ok: false, status: 401 });
  });

  it("is still 503 when OWNER_API_TOKEN isn't usable, even with a cookie signed by the old token", () => {
    for (const configured of [undefined, "", "short"]) {
      expect(checkOwnerAuth(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`), configured, NOW_MS)).toMatchObject({
        ok: false,
        status: 503,
      });
    }
  });

  describe("CSRF guard: a cookie-authenticated write must come from this origin", () => {
    const cookie = `${OWNER_SESSION_COOKIE}=${VALID}`;

    it.each(["POST", "PUT", "PATCH", "DELETE"])("accepts %s from the same origin", (method) => {
      expect(check(withCookie(cookie, { method }))).toEqual({ ok: true });
    });

    it.each([
      ["no Origin header", null],
      ["another site", "https://evil.example"],
      ['the opaque origin "null"', "null"],
      ["the same host over http", "http://front-desk.example"],
      ["the same host on another port", "https://front-desk.example:8443"],
      ["a subdomain", "https://www.front-desk.example"],
      ["the origin with a trailing slash", `${ORIGIN}/`],
    ])("rejects a write from %s with 403 invalid_request", (_name, origin) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(check(withCookie(cookie, { method, origin }))).toEqual({
          ok: false,
          status: 403,
          body: {
            error: {
              code: "invalid_request",
              message:
                "Refused a write signed in with the owner session cookie: the Origin header is missing or isn't this site.",
              next_action:
                "Send it from the Front Desk console on this site (the browser adds the matching Origin header), or authenticate with Authorization: Bearer <OWNER_API_TOKEN> instead of the cookie.",
            },
          },
          headers: {},
        });
      }
    });

    it("leaves Bearer requests alone: the right token writes from any origin, or none", () => {
      for (const origin of [null, "https://evil.example", ORIGIN]) {
        const request = withCookie(undefined, { method: "PUT", origin, authorization: `Bearer ${TOKEN}` });
        expect(check(request)).toEqual({ ok: true });
      }
    });

    it("checks the Origin of a write that has a valid cookie and a wrong bearer token", () => {
      const init = { method: "PUT", authorization: "Bearer wrong-token-of-some-length" };
      expect(check(withCookie(cookie, init))).toEqual({ ok: true });
      expect(check(withCookie(cookie, { ...init, origin: "https://evil.example" }))).toMatchObject({ status: 403 });
    });

    it("rejects an invalid cookie with 401, not 403, whatever the Origin", () => {
      expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${expired}`, { method: "PUT", origin: "https://evil.example" }))).toMatchObject({
        status: 401,
      });
    });
  });
});

describe("requestOrigin: the origin the browser used, from the forwarding headers", () => {
  // Next.js builds request.url from the server's own hostname and port, so a route sees
  // http://localhost:3000 whatever the browser typed. Next.js and Vercel set these headers.
  const NEXT_URL = "http://localhost:3000/api/shops/harts/policies";
  const req = (headers: Record<string, string>, url = NEXT_URL) => new Request(url, { method: "PUT", headers });

  it.each([
    ["X-Forwarded-Host and -Proto (Vercel)", { "x-forwarded-host": "front-desk.vercel.app", "x-forwarded-proto": "https" }, "https://front-desk.vercel.app"],
    ["X-Forwarded-Host over http (next start via 127.0.0.1)", { "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" }, "http://127.0.0.1:3000"],
    ["Host when there's no X-Forwarded-Host", { host: "192.168.1.20:3000" }, "http://192.168.1.20:3000"],
    ["the first entry of a list", { "x-forwarded-host": "a.example, b.example", "x-forwarded-proto": "https, http" }, "https://a.example"],
    ["a default port, dropped", { "x-forwarded-host": "front-desk.example:443", "x-forwarded-proto": "https" }, "https://front-desk.example"],
    ["an uppercase host and scheme, lowercased", { "x-forwarded-host": "Front-Desk.Example", "x-forwarded-proto": "HTTPS" }, "https://front-desk.example"],
    ["an IPv6 loopback", { "x-forwarded-host": "[::1]:3000" }, "http://[::1]:3000"],
    ["request.url when there are no headers", {}, "http://localhost:3000"],
  ])("uses %s", (_name, headers, expected) => {
    expect(requestOrigin(req(headers))).toBe(expected);
  });

  it.each([
    ["a host with a path", { "x-forwarded-host": "evil.example/front-desk.example" }],
    ["a host with user info", { "x-forwarded-host": "front-desk.example@evil.example" }],
    ["a non-http scheme", { "x-forwarded-host": "front-desk.example", "x-forwarded-proto": "javascript" }],
  ])("is null (nothing is same-origin) for %s", (_name, headers) => {
    expect(requestOrigin(req(headers))).toBeNull();
  });

  describe("the CSRF guard uses it", () => {
    const NOW_MS = Date.parse("2026-11-07T22:00:00Z");
    const cookie = `${OWNER_SESSION_COOKIE}=${ownerSessionValue(TOKEN, NOW_MS / 1000 + 3600)}`;
    const write = (headers: Record<string, string>) => checkOwnerAuth(req({ cookie, ...headers }), TOKEN, NOW_MS);

    it("accepts a write whose Origin matches the forwarded host, though request.url says localhost", () => {
      const vercel = { "x-forwarded-host": "front-desk.vercel.app", "x-forwarded-proto": "https" };
      expect(write({ ...vercel, origin: "https://front-desk.vercel.app" })).toEqual({ ok: true });
      expect(write({ ...vercel, origin: "http://localhost:3000" })).toMatchObject({ status: 403 });
      const loopback = { "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" };
      expect(write({ ...loopback, origin: "http://127.0.0.1:3000" })).toEqual({ ok: true });
    });

    it("refuses every write when the headers don't make an origin, even an Origin equal to request.url's", () => {
      expect(write({ "x-forwarded-host": "evil.example/x", origin: "http://localhost:3000" })).toMatchObject({ status: 403 });
      expect(write({ "x-forwarded-proto": "javascript", origin: "null" })).toMatchObject({ status: 403 });
    });
  });
});
