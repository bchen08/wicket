import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthorizationParams, ClientRegistrationResponse, TokenResponse } from "../../types/oauth";
import type { Clock } from "../clock";
import { createMemoryStore } from "../frontdesk/memory-store";
import { NOW } from "../frontdesk/test-support";
import { answerAuthorization, getSigninView, startAuthorization } from "./authorize";
import { isMetadataDocumentUrl, METADATA_CACHE_MS, redirectUriAllowed, registerClient } from "./clients";
import type { SigninDeps } from "./deps";
import { authorizationServerMetadataGet, protectedResourceGet } from "./http";
import { createMemorySigninStore } from "./memory-store";
import { ACCESS_TOKEN_SECONDS, CODE_SECONDS, REFRESH_TOKEN_SECONDS } from "./metadata";
import type { SigninStore } from "./store";
import { exchangeToken, s256 } from "./token";

// Front Desk as an OAuth 2.1 authorization server, through its use cases: discovery documents, the
// authorization code flow with PKCE (a client identified by a Client ID Metadata Document, and one that
// registered dynamically), refresh, and the requests it refuses. The MCP side of a token is in
// lib/server/identity/customer.test.ts.

const BASE = "https://frontdesk.test";
const CLIENT_ID = "https://client.example/oauth/client.json";
const CALLBACK = "https://client.example/callback";

let now: Date;
const clock: Clock = { now: () => new Date(now.getTime()) };
let store: SigninStore;
let fetches: string[];
let document: Record<string, unknown>;
let deps: SigninDeps;

/** A fetch that serves the test client's metadata document and counts the requests. */
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  fetches.push(url);
  if (url !== CLIENT_ID) return new Response("not found", { status: 404 });
  return Response.json(document);
}) as typeof fetch;

beforeEach(() => {
  now = new Date(NOW);
  store = createMemorySigninStore();
  fetches = [];
  document = { client_id: CLIENT_ID, client_name: "Test Agent", redirect_uris: [CALLBACK, "http://127.0.0.1/callback"] };
  deps = { clock, catalog: createMemoryStore({ clock }), store, fetch: fakeFetch, baseUrl: BASE };
});

/** A PKCE pair. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

function authParams(overrides: Partial<AuthorizationParams> = {}): AuthorizationParams {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    state: "xyz-state",
    scope: "bookings",
    resource: `${BASE}/api/mcp`,
    ...overrides,
  };
}

/** Sign in through the form and return the code the client receives (failing the test otherwise). */
async function signIn(params: AuthorizationParams, name = "Maya Lopez", phone = "+14015550123"): Promise<string> {
  const answer = await answerAuthorization(deps, { params, decision: "allow", name, phone });
  expect(answer.status).toBe(303);
  const location = new URL((answer as { location: string }).location);
  expect(`${location.origin}${location.pathname}`).toBe(params.redirect_uri);
  expect(location.searchParams.get("state")).toBe(params.state);
  expect(location.searchParams.get("iss")).toBe(BASE);
  const code = location.searchParams.get("code");
  expect(code).toMatch(/^fdc_[A-Za-z0-9_-]{43}$/);
  return code!;
}

async function tokensFor(code: string, verifier: string, clientId = CLIENT_ID, redirectUri = CALLBACK): Promise<TokenResponse> {
  const outcome = await exchangeToken(deps, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: `${BASE}/api/mcp`,
  });
  expect(outcome).toMatchObject({ status: 200 });
  return outcome.body as TokenResponse;
}

describe("discovery documents", () => {
  it("serves protected resource metadata for /api/mcp on the request's origin", async () => {
    const res = protectedResourceGet(new Request(`${BASE}/.well-known/oauth-protected-resource/api/mcp`));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      resource: `${BASE}/api/mcp`,
      authorization_servers: [BASE],
      scopes_supported: ["bookings"],
      bearer_methods_supported: ["header"],
      resource_name: "Front Desk",
    });
  });

  it("serves authorization server metadata: code + PKCE S256, CIMD, registration, public clients, iss", async () => {
    const res = authorizationServerMetadataGet(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/api/oauth/authorize`,
      token_endpoint: `${BASE}/api/oauth/token`,
      registration_endpoint: `${BASE}/api/oauth/register`,
      scopes_supported: ["bookings"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("authorization code + PKCE with a Client ID Metadata Document", () => {
  it("runs the whole flow: authorize → /signin → allow → code → tokens", async () => {
    const { verifier, challenge } = pkce();
    const params = authParams({ code_challenge: challenge });

    // GET /api/oauth/authorize sends the person to /signin with the same parameters.
    const start = await startAuthorization(deps, params);
    expect(start.status).toBe(302);
    const signinUrl = new URL((start as { location: string }).location);
    expect(`${signinUrl.origin}${signinUrl.pathname}`).toBe(`${BASE}/signin`);
    expect(signinUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(fetches).toEqual([CLIENT_ID]);

    // /signin names the agent and the shop.
    const view = await getSigninView(deps, (n) => signinUrl.searchParams.get(n));
    expect(view).toMatchObject({
      kind: "ask",
      clientName: "Test Agent",
      clientHost: "client.example",
      shop: { slug: "harts", name: "Hart's Barbers" },
      error: null,
    });
    // The metadata document was cached, not fetched again.
    expect(fetches).toEqual([CLIENT_ID]);

    const code = await signIn(params);
    const tokens = await tokensFor(code, verifier);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, scope: "bookings" });
    expect(tokens.access_token).toMatch(/^fda_/);
    expect(tokens.refresh_token).toMatch(/^fdr_/);

    // The access token belongs to the customer the person signed in as, for an hour.
    const access = await store.getToken(tokens.access_token, "access");
    expect(access?.customer).toMatchObject({ shopSlug: "harts", name: "Maya Lopez", phone: "+14015550123" });
    expect(access?.token).toMatchObject({ clientId: CLIENT_ID, shopSlug: "harts", resource: `${BASE}/api/mcp` });
    expect(access?.token.expiresAt.getTime()).toBe(NOW.getTime() + ACCESS_TOKEN_SECONDS * 1000);
    const refresh = await store.getToken(tokens.refresh_token, "refresh");
    expect(refresh?.token.expiresAt.getTime()).toBe(NOW.getTime() + REFRESH_TOKEN_SECONDS * 1000);
  });

  it("finds the same customer by (shop, phone) next time, with the newest name", async () => {
    const first = pkce();
    const a = await tokensFor(await signIn(authParams({ code_challenge: first.challenge }), "Maya"), first.verifier);
    const second = pkce();
    // A US number typed the local way is the same E.164 number.
    const b = await tokensFor(
      await signIn(authParams({ code_challenge: second.challenge }), "Maya Lopez", "(401) 555-0123"),
      second.verifier,
    );
    const ca = (await store.getToken(a.access_token, "access"))!.customer;
    const cb = (await store.getToken(b.access_token, "access"))!.customer;
    expect(cb.id).toBe(ca.id);
    expect(cb.name).toBe("Maya Lopez");
  });

  it("accepts a loopback redirect URI on any port, as native clients use", async () => {
    const { verifier, challenge } = pkce();
    const params = authParams({ redirect_uri: "http://127.0.0.1:53123/callback", code_challenge: challenge });
    expect((await startAuthorization(deps, params)).status).toBe(302);
    const code = await signIn(params);
    await tokensFor(code, verifier, CLIENT_ID, "http://127.0.0.1:53123/callback");
  });

  it("refetches the metadata document after an hour", async () => {
    await startAuthorization(deps, authParams());
    now = new Date(NOW.getTime() + METADATA_CACHE_MS + 1);
    document = { ...document, client_name: "Renamed Agent" };
    const view = await getSigninView(deps, (n) => (authParams() as Record<string, string>)[n]);
    expect(view).toMatchObject({ kind: "ask", clientName: "Renamed Agent" });
    expect(fetches).toEqual([CLIENT_ID, CLIENT_ID]);
  });

  it("sends Deny back to the client as access_denied", async () => {
    const answer = await answerAuthorization(deps, { params: authParams(), decision: "deny", name: "", phone: "" });
    expect(answer.status).toBe(303);
    const location = new URL((answer as { location: string }).location);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("xyz-state");
    expect(location.searchParams.get("iss")).toBe(BASE);
  });

  it("sends a bad name or number back to /signin with an error code and nothing personal in the URL", async () => {
    for (const [name, phone, error] of [
      ["", "+14015550123", "invalid_name"],
      ["x".repeat(81), "+14015550123", "invalid_name"],
      ["Maya", "12345", "invalid_phone"],
      ["Maya", "", "invalid_phone"],
    ] as const) {
      const answer = await answerAuthorization(deps, { params: authParams(), decision: "allow", name, phone });
      expect(answer.status).toBe(303);
      const location = new URL((answer as { location: string }).location);
      expect(location.pathname).toBe("/signin");
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.search).not.toContain("12345");
      const view = await getSigninView(deps, (n) => location.searchParams.get(n));
      expect(view).toMatchObject({ kind: "ask", error });
    }
  });
});

describe("authorization code + PKCE with dynamic client registration", () => {
  it("registers a public client, then runs the flow with its client_id", async () => {
    const registered = (await registerClient(deps, "harts", {
      client_name: "Registered Agent",
      redirect_uris: ["https://chat.example/oauth/callback"],
      token_endpoint_auth_method: "client_secret_basic",
    })) as ClientRegistrationResponse;
    expect(registered).toMatchObject({
      client_name: "Registered Agent",
      redirect_uris: ["https://chat.example/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(registered.client_id).toMatch(/^fd_client_/);

    const { verifier, challenge } = pkce();
    // redirect_uri may be left out when the client declared exactly one.
    const params = authParams({ client_id: registered.client_id, redirect_uri: "", code_challenge: challenge });
    const view = await getSigninView(deps, (n) => (params as Record<string, string>)[n]);
    expect(view).toMatchObject({ kind: "ask", clientName: "Registered Agent", clientHost: "chat.example" });
    const filled = { ...params, redirect_uri: "https://chat.example/oauth/callback" };
    const code = await signIn(filled);
    await tokensFor(code, verifier, registered.client_id, "https://chat.example/oauth/callback");
    expect(fetches).toEqual([]);
  });

  it("refuses a registration without redirect URIs", async () => {
    await expect(registerClient(deps, "harts", { client_name: "No Redirects" })).rejects.toMatchObject({
      code: "invalid_redirect_uri",
    });
    await expect(registerClient(deps, "harts", "not json")).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });
});

describe("refresh", () => {
  it("answers a refresh with a new access token and a new refresh token; the old one keeps working until it expires", async () => {
    const { verifier, challenge } = pkce();
    const first = await tokensFor(await signIn(authParams({ code_challenge: challenge })), verifier);

    now = new Date(NOW.getTime() + 2 * ACCESS_TOKEN_SECONDS * 1000);
    const refreshed = await exchangeToken(deps, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID });
    expect(refreshed.status).toBe(200);
    const second = refreshed.body as TokenResponse;
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const access = await store.getToken(second.access_token, "access");
    expect(access?.token.expiresAt.getTime()).toBe(now.getTime() + ACCESS_TOKEN_SECONDS * 1000);
    expect(access?.customer.name).toBe("Maya Lopez");

    // A retried refresh (e.g. after a dropped response) still works.
    expect((await exchangeToken(deps, { grant_type: "refresh_token", refresh_token: first.refresh_token })).status).toBe(200);

    // After 30 days the first refresh token is done: invalid_grant, so the client signs in again.
    now = new Date(NOW.getTime() + REFRESH_TOKEN_SECONDS * 1000);
    expect(await exchangeToken(deps, { grant_type: "refresh_token", refresh_token: first.refresh_token })).toEqual({
      status: 400,
      body: { error: "invalid_grant", error_description: expect.any(String) },
    });
  });

  it("refuses an unknown refresh token, an access token used as one, and another client's", async () => {
    const { verifier, challenge } = pkce();
    const tokens = await tokensFor(await signIn(authParams({ code_challenge: challenge })), verifier);
    const forms: Record<string, string>[] = [
      { grant_type: "refresh_token", refresh_token: "fdr_nope" },
      { grant_type: "refresh_token", refresh_token: tokens.access_token },
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "https://other.example/client.json" },
    ];
    for (const form of forms) {
      expect(await exchangeToken(deps, form)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    }
  });
});

describe("what the token endpoint refuses", () => {
  it("a wrong code_verifier, a used code, an expired code", async () => {
    const { verifier, challenge } = pkce();
    const code = await signIn(authParams({ code_challenge: challenge }));
    const exchange = (form: Record<string, string>) => exchangeToken(deps, { grant_type: "authorization_code", ...form });

    expect(await exchange({ code, code_verifier: pkce().verifier })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // A code is good for one try, even a failed one.
    expect(await exchange({ code, code_verifier: verifier })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const late = pkce();
    const lateCode = await signIn(authParams({ code_challenge: late.challenge }));
    now = new Date(NOW.getTime() + CODE_SECONDS * 1000);
    expect(await exchange({ code: lateCode, code_verifier: late.verifier })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("a code sent by another client or with another redirect URI", async () => {
    const one = pkce();
    const code = await signIn(authParams({ code_challenge: one.challenge }));
    expect(
      await exchangeToken(deps, { grant_type: "authorization_code", code, code_verifier: one.verifier, client_id: "fd_client_other" }),
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const two = pkce();
    const code2 = await signIn(authParams({ code_challenge: two.challenge }));
    expect(
      await exchangeToken(deps, {
        grant_type: "authorization_code",
        code: code2,
        code_verifier: two.verifier,
        redirect_uri: "https://client.example/elsewhere",
      }),
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("a missing or unsupported grant_type, and missing fields", async () => {
    expect(await exchangeToken(deps, {})).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await exchangeToken(deps, { grant_type: "client_credentials" })).toMatchObject({
      status: 400,
      body: { error: "unsupported_grant_type" },
    });
    expect(await exchangeToken(deps, { grant_type: "authorization_code", code: "x" })).toMatchObject({
      status: 400,
      body: { error: "invalid_request" },
    });
  });
});

describe("what the authorization endpoint refuses", () => {
  it("shows (never redirects) an unknown client, an unreadable or mismatched metadata document, an undeclared redirect URI", async () => {
    const cases: Partial<AuthorizationParams>[] = [
      { client_id: "fd_client_unknown" },
      { client_id: "https://client.example/missing.json" },
      { redirect_uri: "https://evil.example/callback" },
      { redirect_uri: "http://localhost:4000/callback" },
      { client_id: "" },
    ];
    for (const overrides of cases) {
      const answer = await startAuthorization(deps, authParams(overrides));
      expect(answer.status, JSON.stringify(overrides)).toBe(400);
      expect(await getSigninView(deps, (n) => (authParams(overrides) as Record<string, string>)[n])).toMatchObject({ kind: "error" });
    }
    // A document whose client_id isn't its own URL (fetched fresh: nothing cached in a new store).
    document = { ...document, client_id: "https://someone-else.example/client.json" };
    const fresh = { ...deps, store: createMemorySigninStore() };
    expect(await startAuthorization(fresh, authParams({ client_id: CLIENT_ID }))).toMatchObject({ status: 400 });
  });

  it("sends a request without PKCE S256 or with another response_type back to the client as an OAuth error", async () => {
    for (const [overrides, error] of [
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
    ] as const) {
      const answer = await startAuthorization(deps, authParams(overrides));
      expect(answer.status).toBe(302);
      const location = new URL((answer as { location: string }).location);
      expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe("xyz-state");
    }
  });
});

describe("client helpers", () => {
  it("recognizes metadata document URLs", () => {
    expect(isMetadataDocumentUrl("https://claude.ai/oauth/claude-code-client-metadata")).toBe(true);
    expect(isMetadataDocumentUrl("https://chatgpt.com/oauth/client.json")).toBe(true);
    expect(isMetadataDocumentUrl("https://example.com/")).toBe(false);
    expect(isMetadataDocumentUrl("http://example.com/client.json")).toBe(false);
    expect(isMetadataDocumentUrl("fd_client_abc")).toBe(false);
  });

  it("matches redirect URIs exactly, and loopback ones on any port", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed(registered, "http://localhost:3118/callback")).toBe(true);
    expect(redirectUriAllowed(registered, "http://127.0.0.1:61000/callback")).toBe(true);
    expect(redirectUriAllowed(registered, "http://localhost:3118/other")).toBe(false);
    expect(redirectUriAllowed(registered, "https://claude.ai:444/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
  });
});
