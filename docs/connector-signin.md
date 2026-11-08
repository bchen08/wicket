# Connector sign-in

People connect Front Desk to Claude or ChatGPT once and sign in with their name and mobile number. From then on their agent books **as them**: no retyping the name, and the agent can list and manage the person's own bookings. Agents that don't sign in keep working exactly as before.

Front Desk is the OAuth 2.1 authorization server for its own MCP endpoint (`<origin>/api/mcp`), following the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (2026-07-28) and Claude's [lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication) pattern. Every deployment (each preview, production) is its own issuer, built from the request's origin, with no setting.

MVP: nothing here is hashed or rate-limited, and the phone number isn't verified yet (`TODO(ring-2)`: a texted code once texting lands). See [Security not built](#security-not-built).

## What a person sees

1. **Claude:** Customize → Connectors → **Add custom connector**, URL `https://<deployment>/api/mcp`. **ChatGPT** (developer mode): create a connector with that URL and Authentication **OAuth**.
2. The agent asks to sign in, either right away (ChatGPT, or Claude's **Sign in now**) or as an inline **Connect** card the first time it needs the person (Claude's default: see [The gate](#the-gate)).
3. The sign-in page, `/signin`, says which agent wants access to Hart's Barbers and from where (e.g. "Claude (claude.ai)"), and asks for their **name** and **mobile number**, with **Allow** and **Deny**. A US number can be typed the local way (`401 555 0123`); others need `+` and the country code.
4. Allow → back to the agent, signed in. "Book me a haircut Wednesday morning" books under their name and number. They still approve every booking with the link `book` returns.
5. "What appointments do I have at Hart's?" → `list_my_bookings`. "Cancel the Wednesday one" → `cancel` with that booking's id.

The customer is found or created by **(shop, phone)**: signing in again with the same number, from any agent, is the same customer (with the newest name).

## The gate

`/api/mcp` is wrapped in mcp-handler's `withMcpAuth` (`withCustomerSignin` in [`lib/server/identity/customer.ts`](../lib/server/identity/customer.ts)):

| Request | Answer |
|---|---|
| No `Authorization` header | Served exactly as before: `initialize`, `tools/list` and every tool call, except the two below. |
| No token, `tools/call` of `list_my_bookings` | **HTTP 401** with `WWW-Authenticate: Bearer error="invalid_token", error_description="Sign in to Front Desk to see your bookings.", scope="bookings", resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"` |
| No token, `tools/call` of `book` without `customer_name` (missing, null or blank) | The same 401, "Sign in to Front Desk to book as yourself, or call book again with customer_name." |
| `Authorization: Bearer <valid access token>` | Served, with the tools acting for the token's customer (below). |
| An unknown or expired token, on any request | 401 `invalid_token`, so the client refreshes it or signs in again. |

Claude starts sign-in only on an HTTP 401 with `WWW-Authenticate` (a tool error inside a 200 doesn't), then retries the same call with the new token. That is why the refusal happens in the HTTP layer, before the MCP SDK runs, and why it's limited to calls that only make sense signed in: an agent that sends `customer_name` never sees it.

With a valid token:
- **`book`** fills `customer_name` and `customer_phone` from the customer when the agent leaves them out, and records the booking as theirs (`bookings.customer_id`). The number works like any `customer_phone`: stored as `customer.phone` and, where texting is on, texted the approval link (`texted: true`). An agent may still send a name or number (booking for someone else); the booking is still the customer's.
- **`list_my_bookings`** (new) returns the customer (`name`, `phone`) and their bookings at the shop that end within the last 7 days or later, any status, sorted by start, at most 50 (`ListMyBookingsResult` in [`lib/types/oauth.ts`](../lib/types/oauth.ts)). Lapsed holds read as expired; a hold carries its approval link. Each line of the text has the booking id.
- **`get_booking`** and **`cancel`** work on those ids, so the agent never guesses one. They behave as before otherwise (an id is still enough, signed in or not).

`book`'s `customer_name` is no longer in the tool's `required` list (`BookInput.customer_name` is optional): signed-in agents leave it out. Without sign-in, a call through the gate without it gets the 401 above; the handler on its own still answers `invalid_request` for it.

## Endpoints

| | |
|---|---|
| Protected resource metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-protected-resource` → `ProtectedResourceMetadata`: `resource: <origin>/api/mcp`, `authorization_servers: [<origin>]`, `scopes_supported: ["bookings"]` |
| Authorization server metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server` → `AuthorizationServerMetadata`: issuer `<origin>`; code + PKCE `S256` only; `client_id_metadata_document_supported: true`; `token_endpoint_auth_methods_supported: ["none"]`; `authorization_response_iss_parameter_supported: true` |
| Authorization | `GET /api/oauth/authorize` checks the request and 302s to `/signin` with the same parameters; `POST /api/oauth/authorize` is the `/signin` form |
| Sign-in page | `/signin` ([`app/signin/page.tsx`](../app/signin/page.tsx); a plain stand-in that v0 restyles). It reads `SigninView` from `getSigninView` |
| Token | `POST /api/oauth/token`, form-encoded (JSON is accepted too): `authorization_code` and `refresh_token` |
| Registration (RFC 7591) | `POST /api/oauth/register`, JSON → `ClientRegistrationResponse` (201) |

The `/.well-known` paths are rewrites in `next.config.ts` to routes under `app/api/oauth/`. Discovery, token and registration answer CORS (`Access-Control-Allow-Origin: *`) for clients that run in a browser. The code is in [`lib/server/oauth/`](../lib/server/oauth/): `metadata.ts` (paths, lifetimes, the documents), `clients.ts`, `authorize.ts`, `token.ts`, `http.ts` (the route adapters), `store.ts` with `postgres-store.ts` and `memory-store.ts`, and `deps.ts`.

### Clients

As the spec orders them:

1. **Client ID Metadata Documents** (preferred). The `client_id` is an HTTPS URL with a path (e.g. Claude's or ChatGPT's published document). Front Desk fetches it (5-second timeout), checks that its `client_id` is its own URL and that it lists `redirect_uris`, and caches it in `oauth_clients` for an hour. A redirect URI the cached copy doesn't list triggers a fresh fetch. `client_name` is what `/signin` shows, next to the redirect URI's host.
2. **Dynamic client registration** (the fallback). `POST /api/oauth/register` with at least `redirect_uris` returns a `client_id` (`fd_client_…`). Every client is public: whatever `token_endpoint_auth_method` it asks for, the answer is `none`, and no secret is issued.

Redirect URIs match exactly, except loopback `http` URIs (`localhost`, `127.0.0.1`, `[::1]`), which match on any port (RFC 8252; Claude Code and other native clients pick a port per sign-in). Claude's hosted callback is `https://claude.ai/api/mcp/auth_callback`; ChatGPT's is `https://chatgpt.com/connector_platform_oauth_redirect`. Both come from their metadata documents or registrations; nothing is configured here.

An unknown client, a metadata document that can't be read, or a redirect URI the client didn't declare is shown to the person as an error page (400) and never redirected. A wrong `response_type` or a missing PKCE `S256` challenge goes back to the redirect URI as an OAuth error (`unsupported_response_type`, `invalid_request`), with `state` and `iss`.

### Codes and tokens

- **Authorization code:** `fdc_…`, 10 minutes, exchanged once (a failed exchange uses it up too). The exchange checks the PKCE verifier against the stored S256 challenge, and, when sent, that `client_id` and `redirect_uri` match.
- **Access token:** `fda_…`, **1 hour**, scope `bookings`.
- **Refresh token:** `fdr_…`, **30 days**. A refresh returns a new access token and a new refresh token (30 days from then). The old refresh token keeps working until its own expiry, so a retried refresh never signs the person out. An unknown or expired one is `invalid_grant`: sign in again.
- The authorization response carries `iss` (RFC 9207). The `resource` parameter (RFC 8707) is stored with the code and tokens as given; there is one protected resource, `/api/mcp`, so every token is for it.

Everything carries `shop_slug`. Today there is one issuer, for `harts` (`SIGNIN_SHOP_SLUG`); `TODO(ring-2)`: an issuer per shop once agents pick the shop.

## Database (`0008_signin.sql`)

Additive: four new tables (RLS on, no policies) and one nullable column.

- `customers (id, shop_slug, name, phone, created_at, updated_at)`, unique `(shop_slug, phone)`. `phone` is E.164, unverified.
- `bookings.customer_id` → `customers`, null for bookings made without sign-in. Indexed for `list_my_bookings`.
- `oauth_clients (shop_slug, client_id, kind cimd|registered, client_name, redirect_uris jsonb, fetched_at, created_at)`.
- `oauth_codes (code, shop_slug, client_id, customer_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at, created_at)`.
- `oauth_tokens (token, kind access|refresh, shop_slug, client_id, customer_id, scope, resource, expires_at, created_at)`.

Codes, tokens and client records are stored as they are (MVP rule). `/api/status` lists the new tables and `bookings.customer_id` in its schema check, so a database without 0008 shows `"schema": "outdated"`. **Apply 0008 before deploying this code:** `book` writes `customer_id` on every booking. Without `DATABASE_URL` (local `pnpm dev`) sign-ins live in memory and are lost on restart, like the demo bookings.

## Try it locally

```bash
pnpm dev
# Discovery
curl -s localhost:3000/.well-known/oauth-protected-resource/api/mcp
curl -s localhost:3000/.well-known/oauth-authorization-server
# The sign-in challenge: list_my_bookings without a token → 401 with WWW-Authenticate
curl -si localhost:3000/api/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_my_bookings","arguments":{}}}'
```

The whole flow from a terminal: `pnpm smoke http://localhost:3000` runs S1–S7 ([SMOKE.md](../SMOKE.md#connector-sign-in-claude-and-chatgpt-connectors)), which register a client, sign in through `/signin`'s form, exchange the code, book without a name, list, cancel and refresh. MCP Inspector (`npx @modelcontextprotocol/inspector`) can sign in interactively too: connect to `http://localhost:3000/api/mcp` and use its auth flow.

A Claude connector needs a public HTTPS URL: a preview (with a Vercel bypass link) or a tunnel to `pnpm dev`.

## Security not built

MVP rule: none of this is built; each is a line in the PR's "Security not built".

- The mobile number isn't verified: anyone who types a number signs in as that number's customer and sees and cancels their bookings. `TODO(ring-2)`: a texted code once texting lands.
- Tokens, codes and client records are stored in plain text.
- Refresh tokens aren't rotated, and nothing revokes tokens (no sign-out).
- No rate limits on sign-in, registration or the token endpoint.
- The metadata document fetch doesn't block private or internal addresses.
- The `resource` a token was issued for isn't checked against `/api/mcp` (there is only one resource).
- `get_booking` and `cancel` still work for anyone holding a booking id, signed in or not (as before).
