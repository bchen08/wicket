import { createHash, randomBytes } from "node:crypto";
import type { OAuthErrorResponse, TokenResponse } from "../../types/oauth";
import type { SigninDeps } from "./deps";
import { ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_SECONDS, SCOPE } from "./metadata";
import type { OAuthToken } from "./store";

// The token endpoint (POST /api/oauth/token, form-encoded): authorization_code (with the PKCE verifier)
// and refresh_token. Public clients: no client secret. Access tokens last an hour, refresh tokens 30 days.
// A refresh answers with a new access token and a new refresh token; the old refresh token keeps working
// until it expires (no rotation, MVP), so a retried refresh never signs the person out.

/** What the token endpoint answers. */
export type TokenOutcome = { status: 200; body: TokenResponse } | { status: 400; body: OAuthErrorResponse };

const fail = (error: OAuthErrorResponse["error"], description: string): TokenOutcome => ({
  status: 400,
  body: { error, error_description: description },
});

/** PKCE S256: base64url(SHA-256(verifier)). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

/** Issue an access token and a refresh token for the same grant. */
async function issueTokens(
  deps: SigninDeps,
  grant: Pick<OAuthToken, "shopSlug" | "clientId" | "customerId" | "resource">,
): Promise<TokenOutcome> {
  const now = deps.clock.now().getTime();
  const access: OAuthToken = {
    ...grant,
    token: newToken("fda"),
    kind: "access",
    scope: SCOPE,
    expiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000),
  };
  const refresh: OAuthToken = {
    ...grant,
    token: newToken("fdr"),
    kind: "refresh",
    scope: SCOPE,
    expiresAt: new Date(now + REFRESH_TOKEN_SECONDS * 1000),
  };
  await deps.store.createTokens([access, refresh]);
  return {
    status: 200,
    body: {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh.token,
      scope: SCOPE,
    },
  };
}

/**
 * Answer a token request. `form` is the request's fields. client_id and redirect_uri, when sent, must
 * match the ones the code was issued for.
 */
export async function exchangeToken(deps: SigninDeps, form: Record<string, string>): Promise<TokenOutcome> {
  const clientId = form.client_id ?? "";
  switch (form.grant_type) {
    case "authorization_code": {
      if (!form.code) return fail("invalid_request", "code is required.");
      if (!form.code_verifier) return fail("invalid_request", "code_verifier is required (PKCE).");
      // Used up here even if a check below fails: a code is good for one try.
      const code = await deps.store.useCode(form.code, deps.clock.now());
      if (!code) return fail("invalid_grant", "The code is unknown, expired or already used. Sign in again.");
      if (clientId !== "" && clientId !== code.clientId) return fail("invalid_grant", "The code was issued to another client.");
      if (form.redirect_uri && form.redirect_uri !== code.redirectUri) {
        return fail("invalid_grant", "redirect_uri doesn't match the one the code was issued for.");
      }
      if (s256(form.code_verifier) !== code.codeChallenge) {
        return fail("invalid_grant", "code_verifier doesn't match the code_challenge. Sign in again.");
      }
      return issueTokens(deps, {
        shopSlug: code.shopSlug,
        clientId: code.clientId,
        customerId: code.customerId,
        resource: form.resource || code.resource,
      });
    }
    case "refresh_token": {
      if (!form.refresh_token) return fail("invalid_request", "refresh_token is required.");
      const found = await deps.store.getToken(form.refresh_token, "refresh");
      if (!found || found.token.expiresAt.getTime() <= deps.clock.now().getTime()) {
        return fail("invalid_grant", "The refresh token is unknown or expired. Sign in again.");
      }
      if (clientId !== "" && clientId !== found.token.clientId) {
        return fail("invalid_grant", "The refresh token was issued to another client.");
      }
      return issueTokens(deps, {
        shopSlug: found.token.shopSlug,
        clientId: found.token.clientId,
        customerId: found.token.customerId,
        resource: form.resource || found.token.resource,
      });
    }
    case undefined:
    case "":
      return fail("invalid_request", "grant_type is required: authorization_code or refresh_token.");
    default:
      return fail("unsupported_grant_type", "Front Desk supports grant_type authorization_code and refresh_token.");
  }
}
