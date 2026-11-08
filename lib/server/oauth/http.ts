import type { OAuthErrorResponse } from "../../types/oauth";
import { answerAuthorization, readAuthorizationParams, startAuthorization, type AuthorizeResponse } from "./authorize";
import { registerClient, RegistrationError } from "./clients";
import { getSigninDeps } from "./deps";
import { authorizationServerMetadata, protectedResourceMetadata, SIGNIN_SHOP_SLUG } from "./metadata";
import { exchangeToken } from "./token";

// HTTP adapters for the OAuth routes under app/api/oauth (and the /.well-known paths next.config.ts rewrites
// to them). Each takes the web Request and returns a Response; the use cases are in authorize.ts, token.ts and
// clients.ts. Discovery, token and registration answer CORS requests, for MCP clients that run in a browser.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const originOf = (request: Request) => new URL(request.url).origin;

function json(body: unknown, status: number, cache = "no-store"): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": cache } });
}

/** OPTIONS for the CORS routes. */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** GET /.well-known/oauth-protected-resource[/api/mcp]: where to sign in for the MCP endpoint. */
export function protectedResourceGet(request: Request): Response {
  return json(protectedResourceMetadata(originOf(request)), 200, "public, max-age=300");
}

/** GET /.well-known/oauth-authorization-server: the issuer's endpoints and what it supports. */
export function authorizationServerMetadataGet(request: Request): Response {
  return json(authorizationServerMetadata(originOf(request)), 200, "public, max-age=300");
}

/** The request's fields: a form (urlencoded or multipart) or a JSON object, as strings. */
async function readFields(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const fields: Record<string, string> = {};
  if (type.includes("application/json")) {
    const body: unknown = await request.json().catch(() => null);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const [name, value] of Object.entries(body)) if (typeof value === "string") fields[name] = value;
    }
    return fields;
  }
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    for (const [name, value] of form) if (typeof value === "string") fields[name] = value;
    return fields;
  }
  // application/x-www-form-urlencoded, the OAuth default; also what arrives without a content type.
  for (const [name, value] of new URLSearchParams(await request.text())) fields[name] = value;
  return fields;
}

/** A plain page for an authorization request that can't go back to the client. */
function errorPage(message: string, status: number): Response {
  return new Response(`Front Desk can't sign you in.\n\n${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function authorizeAnswer(answer: AuthorizeResponse): Response {
  if (answer.status === 400) return errorPage(answer.message, 400);
  return new Response(null, { status: answer.status, headers: { Location: answer.location, "Cache-Control": "no-store" } });
}

/** Unexpected failures: logged, and answered without details. */
function logFailure(event: string, err: unknown): void {
  console.error(JSON.stringify({ event, shop: SIGNIN_SHOP_SLUG, error: err instanceof Error ? err.message : String(err) }));
}

/** GET /api/oauth/authorize: check the request and send the person to /signin. */
export async function authorizeGet(request: Request): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    return authorizeAnswer(await startAuthorization(getSigninDeps(originOf(request)), readAuthorizationParams((n) => query.get(n))));
  } catch (err) {
    logFailure("oauth.authorize_failed", err);
    return errorPage("Something went wrong on our side. Go back to your assistant and try again.", 500);
  }
}

/** POST /api/oauth/authorize: the /signin form (Allow or Deny). */
export async function authorizePost(request: Request): Promise<Response> {
  try {
    const fields = await readFields(request);
    const answer = await answerAuthorization(getSigninDeps(originOf(request)), {
      params: readAuthorizationParams((n) => fields[n]),
      decision: fields.decision ?? "",
      name: fields.name,
      phone: fields.phone,
    });
    return authorizeAnswer(answer);
  } catch (err) {
    logFailure("oauth.signin_failed", err);
    return errorPage("Something went wrong on our side. Go back to your assistant and try again.", 500);
  }
}

const serverError = (): OAuthErrorResponse => ({ error: "server_error", error_description: "Something went wrong on our side. Try again." });

/** POST /api/oauth/token. */
export async function tokenPost(request: Request): Promise<Response> {
  try {
    const outcome = await exchangeToken(getSigninDeps(originOf(request)), await readFields(request));
    return json(outcome.body, outcome.status);
  } catch (err) {
    logFailure("oauth.token_failed", err);
    return json(serverError(), 500);
  }
}

/** POST /api/oauth/register (RFC 7591, JSON). */
export async function registerPost(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    return json(await registerClient(getSigninDeps(originOf(request)), SIGNIN_SHOP_SLUG, body), 201);
  } catch (err) {
    if (err instanceof RegistrationError) {
      const body: OAuthErrorResponse = { error: err.code, error_description: err.message };
      return json(body, 400);
    }
    logFailure("oauth.register_failed", err);
    return json(serverError(), 500);
  }
}
