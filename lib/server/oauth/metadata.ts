import type { AuthorizationServerMetadata, OAuthScope, ProtectedResourceMetadata } from "../../types/oauth";

// Front Desk as the OAuth 2.1 authorization server for its MCP endpoint: the paths, lifetimes and the two
// discovery documents. Everything is built from the request's origin, so each deployment (previews and
// production) is its own issuer with no setting. See docs/connector-signin.md.

/** The one shop people sign in to, until multi-shop routing lands. Every record still carries its shop. */
// TODO(ring-2): an issuer per shop (e.g. /shops/<slug>) once agents pick the shop.
export const SIGNIN_SHOP_SLUG = "harts";

/** The one scope: book, list and manage the person's bookings at the shop. */
export const SCOPE: OAuthScope = "bookings";

/** The MCP endpoint: the protected resource, and the URL people add as a connector. */
export const MCP_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/api/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";
export const REGISTER_PATH = "/api/oauth/register";
/** The page that asks the person to sign in (app/signin/page.tsx). */
export const SIGNIN_PATH = "/signin";
/** RFC 9728 with the MCP path inserted: what the 401's resource_metadata points at. */
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** How long an authorization code waits to be exchanged. */
export const CODE_SECONDS = 10 * 60;
/** How long a code texted at /signin can be entered. */
export const TEXTED_CODE_SECONDS = 10 * 60;

/** The protected resource metadata for the MCP endpoint on `baseUrl` (served at both well-known paths). */
export function protectedResourceMetadata(baseUrl: string): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}${MCP_PATH}`,
    authorization_servers: [baseUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Front Desk",
  };
}

/** The authorization server metadata for the issuer `baseUrl`. */
export function authorizationServerMetadata(baseUrl: string): AuthorizationServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}${AUTHORIZE_PATH}`,
    token_endpoint: `${baseUrl}${TOKEN_PATH}`,
    registration_endpoint: `${baseUrl}${REGISTER_PATH}`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
