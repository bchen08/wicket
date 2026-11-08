import { describe, expect, it } from "vitest";
import {
  BEARER_NEXT_ACTION,
  checkOwnerAuth,
  NOT_SET_UP_NEXT_ACTION,
  OWNER_AUTH_CHALLENGE,
  OWNER_SESSION_COOKIE,
  ownerTokenMatches,
  UNLOCK_NEXT_ACTION,
} from "./owner-auth";

// The stub owner auth: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie holding the
// token, compared with ===. TODO(ring-2): owner sign-in by texted code replaces both.

const TOKEN = "owner-token-for-tests-0123456789";

function request(init: { authorization?: string; cookie?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.authorization !== undefined) headers.authorization = init.authorization;
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  return new Request("http://localhost/api/shops/harts/policies", { method: init.method ?? "GET", headers });
}

const unauthorized = (message: string, nextAction: string) => ({
  ok: false,
  status: 401,
  body: { error: { code: "unauthorized", message, next_action: nextAction } },
  headers: { "www-authenticate": OWNER_AUTH_CHALLENGE },
});

describe("checkOwnerAuth: the bearer token", () => {
  it.each([
    ["the exact token", `Bearer ${TOKEN}`],
    ['a lowercase "bearer" scheme', `bearer ${TOKEN}`],
    ["an uppercase scheme", `BEARER ${TOKEN}`],
    ["several spaces after the scheme", `Bearer    ${TOKEN}`],
    ["spaces around the token", `Bearer   ${TOKEN}   `],
  ])("accepts %s", (_name, authorization) => {
    expect(checkOwnerAuth(request({ authorization }), TOKEN)).toEqual({ ok: true });
  });

  it("trims the configured token too (e.g. a trailing newline in the env var)", () => {
    expect(checkOwnerAuth(request({ authorization: `Bearer ${TOKEN}` }), `  ${TOKEN}\n`)).toEqual({ ok: true });
  });

  it("accepts a short token: there's no minimum length", () => {
    expect(checkOwnerAuth(request({ authorization: "Bearer abc" }), "abc")).toEqual({ ok: true });
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty Authorization header", ""],
    ["another scheme", `Basic ${TOKEN}`],
    ["the token without a scheme", TOKEN],
    ["the scheme without a space", `Bearer${TOKEN}`],
    ["an empty token", "Bearer "],
    ["a token of only spaces", "Bearer      "],
    ["a wrong token", "Bearer short-wrong-token"],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["the token plus extra characters", `Bearer ${TOKEN}x`],
    ["the token in different case", `Bearer ${TOKEN.toUpperCase()}`],
  ])("rejects %s with 401 unauthorized and a WWW-Authenticate challenge", (_name, authorization) => {
    const result = checkOwnerAuth(request({ authorization }), TOKEN);
    expect(result).toEqual(unauthorized("Missing or wrong owner token.", BEARER_NEXT_ACTION));
    expect(BEARER_NEXT_ACTION).toBe("Send the header Authorization: Bearer <OWNER_API_TOKEN>.");
    expect(OWNER_AUTH_CHALLENGE).toBe('Bearer realm="front-desk-owner"');
    // The configured token is never echoed back.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("uses the caller's next_action for a wrong token, e.g. the bookings list's unlock line", () => {
    expect(UNLOCK_NEXT_ACTION).toBe("Open /console/unlock and enter the shop's access code.");
    expect(checkOwnerAuth(request(), TOKEN, UNLOCK_NEXT_ACTION)).toEqual(
      unauthorized("Missing or wrong owner token.", UNLOCK_NEXT_ACTION),
    );
  });
});

describe("checkOwnerAuth: OWNER_API_TOKEN not set", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   \n"],
  ])("is 401 with the set-up next_action when OWNER_API_TOKEN is %s, whatever the request sends", (_name, configured) => {
    expect(NOT_SET_UP_NEXT_ACTION).toBe("Owner access isn't set up: set OWNER_API_TOKEN in Vercel and redeploy.");
    for (const init of [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer" },
      { authorization: `Bearer ${TOKEN}` },
      { cookie: `${OWNER_SESSION_COOKIE}=` },
      { cookie: `${OWNER_SESSION_COOKIE}=${TOKEN}` },
    ]) {
      // An empty token must not match an empty header or cookie.
      expect(checkOwnerAuth(request(init), configured, UNLOCK_NEXT_ACTION)).toEqual(
        unauthorized("Owner access isn't set up on this deployment.", NOT_SET_UP_NEXT_ACTION),
      );
    }
  });
});

describe("checkOwnerAuth: the fd_owner cookie", () => {
  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])("accepts a cookie holding the token on %s", (method) => {
    expect(checkOwnerAuth(request({ method, cookie: `${OWNER_SESSION_COOKIE}=${TOKEN}` }), TOKEN)).toEqual({ ok: true });
  });

  it("decodes the value: the cookie holds the token URI-encoded", () => {
    const token = "a token; with=odd,chars";
    const cookie = `${OWNER_SESSION_COOKIE}=${encodeURIComponent(token)}`;
    expect(checkOwnerAuth(request({ cookie }), token)).toEqual({ ok: true });
  });

  it("accepts it next to a wrong bearer token", () => {
    const init = { authorization: "Bearer wrong", cookie: `${OWNER_SESSION_COOKIE}=${TOKEN}` };
    expect(checkOwnerAuth(request(init), TOKEN)).toEqual({ ok: true });
  });

  it("finds the cookie among others, and accepts it when any fd_owner value matches", () => {
    expect(checkOwnerAuth(request({ cookie: `theme=dark; ${OWNER_SESSION_COOKIE}=${TOKEN}; other=1` }), TOKEN)).toEqual({ ok: true });
    expect(checkOwnerAuth(request({ cookie: `${OWNER_SESSION_COOKIE}=stale; ${OWNER_SESSION_COOKIE}=${TOKEN}` }), TOKEN)).toEqual({
      ok: true,
    });
  });

  it.each([
    ["a wrong value", `${OWNER_SESSION_COOKIE}=wrong`],
    ["an empty value", `${OWNER_SESSION_COOKIE}=`],
    ["a prefix of the token", `${OWNER_SESSION_COOKIE}=${TOKEN.slice(0, -1)}`],
    ["the token under another name", `fd_owner_x=${TOKEN}`],
    ["a malformed encoding", `${OWNER_SESSION_COOKIE}=%E0%A4%A`],
    ["no cookie at all", undefined],
  ])("rejects %s with 401 unauthorized", (_name, cookie) => {
    expect(checkOwnerAuth(request({ cookie }), TOKEN)).toEqual(unauthorized("Missing or wrong owner token.", BEARER_NEXT_ACTION));
  });

  it("stops working when OWNER_API_TOKEN changes", () => {
    const req = request({ cookie: `${OWNER_SESSION_COOKIE}=${TOKEN}` });
    expect(checkOwnerAuth(req, TOKEN)).toEqual({ ok: true });
    expect(checkOwnerAuth(req, "rotated-owner-token")).toMatchObject({ ok: false, status: 401 });
  });
});

describe("ownerTokenMatches", () => {
  it("compares the trimmed values, and nothing matches an empty token", () => {
    expect(ownerTokenMatches(` ${TOKEN} `, TOKEN)).toBe(true);
    expect(ownerTokenMatches(TOKEN, `${TOKEN}\n`)).toBe(true);
    expect(ownerTokenMatches("", "")).toBe(false);
    expect(ownerTokenMatches(undefined, undefined)).toBe(false);
    expect(ownerTokenMatches(null, "")).toBe(false);
    expect(ownerTokenMatches(" ", " ")).toBe(false);
  });
});
