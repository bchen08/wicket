import { describe, expect, it } from "vitest";
import { checkOwnerAuth, MIN_OWNER_TOKEN_LENGTH, OWNER_AUTH_CHALLENGE } from "./owner-auth";

// The stub owner auth: Authorization: Bearer <OWNER_API_TOKEN>, compared in constant time.
// TODO(ring-2): owner sign-in replaces the token.

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
