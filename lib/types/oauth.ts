// Shared contract for connector sign-in: Front Desk as the OAuth 2.1 authorization server for its MCP
// endpoint (/api/mcp), the /signin page, and the list_my_bookings tool. See docs/connector-signin.md.
// The UI imports these types instead of describing the shapes itself.

import type { Booking } from "./frontdesk";

/** The one scope Front Desk grants: book, list and manage the signed-in person's bookings at the shop. */
export type OAuthScope = "bookings";

/**
 * GET /.well-known/oauth-protected-resource/api/mcp (and /.well-known/oauth-protected-resource):
 * RFC 9728 protected resource metadata for the MCP endpoint.
 */
export type ProtectedResourceMetadata = {
  /** The MCP endpoint, e.g. "https://emergent.vercel.app/api/mcp". The URL people add as a connector. */
  resource: string;
  /** The issuer: this deployment's origin. */
  authorization_servers: string[];
  scopes_supported: OAuthScope[];
  bearer_methods_supported: ["header"];
  /** "Front Desk". */
  resource_name: string;
};

/** GET /.well-known/oauth-authorization-server: RFC 8414 authorization server metadata. */
export type AuthorizationServerMetadata = {
  /** This deployment's origin, without a trailing slash. One issuer, for shop harts. */
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** Dynamic client registration (RFC 7591), for clients that don't use a Client ID Metadata Document. */
  registration_endpoint: string;
  scopes_supported: OAuthScope[];
  response_types_supported: ["code"];
  response_modes_supported: ["query"];
  grant_types_supported: ["authorization_code", "refresh_token"];
  /** Public clients only: PKCE instead of a client secret. */
  token_endpoint_auth_methods_supported: ["none"];
  code_challenge_methods_supported: ["S256"];
  client_id_metadata_document_supported: true;
  /** RFC 9207: the authorization response carries iss. */
  authorization_response_iss_parameter_supported: true;
};

/** POST /api/oauth/token: a successful answer (authorization_code and refresh_token grants alike). */
export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  /** Seconds the access token lasts: 3600. */
  expires_in: number;
  /** Lasts 30 days. A refresh answers with a new one; the old one keeps working until it expires. */
  refresh_token: string;
  scope: OAuthScope;
};

/** An OAuth error answer (RFC 6749 section 5.2), from the token and registration endpoints. */
export type OAuthErrorResponse = {
  error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unsupported_grant_type"
    | "invalid_scope"
    | "invalid_redirect_uri"
    | "invalid_client_metadata"
    | "server_error";
  error_description: string;
};

/** POST /api/oauth/register: the fields Front Desk reads from an RFC 7591 registration request. Others are ignored. */
export type ClientRegistrationRequest = {
  /** Required: at least one. https, or http on a loopback host. */
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
};

/** POST /api/oauth/register: 201 with the new public client. */
export type ClientRegistrationResponse = {
  client_id: string;
  /** Seconds since the epoch. */
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: ["authorization_code", "refresh_token"];
  response_types: ["code"];
  token_endpoint_auth_method: "none";
};

/** The OAuth authorization request's parameters, as /signin carries them in its form. */
export type AuthorizationParams = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  resource: string;
};

/**
 * What the /signin page shows (getSigninView in lib/server/oauth/authorize.ts).
 * "ask": who wants access, and the form (name, mobile number, Allow / Deny) that posts to
 * /api/oauth/authorize with `params` as hidden fields. Where texting is on, Allow texts a code and the page
 * comes back with `textedCode` set, asking for the code instead of the name and number. "error": the request
 * can't be answered (unknown client, a redirect URI it didn't declare, a malformed request); show `message`
 * and nothing else.
 */
export type SigninView =
  | {
      kind: "ask";
      /** The agent asking, as it names itself, e.g. "Claude". */
      clientName: string;
      /** Where the person returns after answering, e.g. "claude.ai". Shown next to the name. */
      clientHost: string;
      /** The shop the person signs in to. */
      shop: { slug: string; name: string };
      /** Hidden form fields: post them back unchanged. */
      params: AuthorizationParams;
      /**
       * Set once a code has been texted (only where texting is on): show one field for it instead of the
       * name and mobile number, and post it as `code` with `id` as a hidden `code_id`. Otherwise null.
       */
      textedCode: {
        id: string;
        /** Where it went, masked, e.g. "•••• 0123". */
        sentTo: string;
      } | null;
      /** Set when the last post was refused. */
      error: SigninFormError | null;
    }
  | { kind: "error"; message: string };

/** Why /api/oauth/authorize sent the person back to /signin (?error=…). */
export type SigninFormError =
  | "invalid_name"
  | "invalid_phone"
  /** The text with the code didn't go through. */
  | "send_failed"
  /** The code entered isn't the one texted. */
  | "invalid_code"
  /** The code has run out or was already used: the page is asking for the name and number again. */
  | "code_expired"
  | "internal";

/** The signed-in person, as list_my_bookings shows them. */
export type CustomerProfile = {
  /** The name they signed in with. book uses it when the agent sends no customer_name. */
  name: string;
  /** Their mobile number, E.164. */
  phone: string;
};

/** Input of the `list_my_bookings` tool: none. */
export type ListMyBookingsInput = Record<string, never>;

/**
 * structuredContent of a successful `list_my_bookings` call: the signed-in person and their bookings at
 * the shop that end within the last 7 days or later, of any status, sorted by start (at most 50).
 */
export type ListMyBookingsResult = {
  customer: CustomerProfile;
  bookings: Booking[];
  /** true if they have more bookings than were returned. */
  truncated: boolean;
};
