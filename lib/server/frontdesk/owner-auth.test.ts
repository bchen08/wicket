import { describe, expect, it } from "vitest";
import {
  checkOwnerAuth,
  MIN_OWNER_TOKEN_LENGTH,
  OWNER_AUTH_CHALLENGE,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_MAX_AGE_S,
  ownerSessionValue,
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

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])("accepts a valid cookie on %s, whatever the Origin", (method) => {
    // MVP: no CSRF check beyond SameSite=Strict, which keeps the browser from sending the cookie cross-site.
    for (const origin of [ORIGIN, null, "https://evil.example"]) {
      expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`, { method, origin }))).toEqual({ ok: true });
    }
  });

  it("accepts a valid cookie even next to a wrong bearer token", () => {
    const init = { method: "PUT", authorization: "Bearer wrong-token-of-some-length" };
    expect(check(withCookie(`${OWNER_SESSION_COOKIE}=${VALID}`, init))).toEqual({ ok: true });
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
});
