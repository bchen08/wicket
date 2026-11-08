import { randomBytes } from "node:crypto";
import type { AuthorizationParams, SigninFormError, SigninView } from "../../types/oauth";
import { parseCustomerName, parseMobile, signInCustomer } from "../identity/customer";
import type { TextSender } from "../notify/text-sender";
import { maskPhone } from "../notify/texting";
import { newTextedCode, signinCodeText } from "../notify/texts";
import { ClientError, clientDisplayName, resolveClient } from "./clients";
import type { SigninDeps } from "./deps";
import { CODE_SECONDS, SCOPE, SIGNIN_PATH, SIGNIN_SHOP_SLUG, TEXTED_CODE_SECONDS } from "./metadata";
import type { OAuthClient } from "./store";

// The authorization endpoint (/api/oauth/authorize) and the /signin page behind it: authorization code
// with PKCE (S256 only), for public clients.
//
//   GET  /api/oauth/authorize?…  check the request, then 302 to /signin?… (same parameters)
//   /signin?…                    "<client> wants to book at Hart's as you": name, mobile number, Allow / Deny
//   POST /api/oauth/authorize    the form: find or create the customer by (shop, phone), then 303 to the
//                                client's redirect_uri with code, state and iss (or error=access_denied)
//
// Where texting is on, Allow doesn't sign in yet. It texts a 6-digit code to the number and 303s back to
// /signin?…&code_id=<id>, which asks for the code; the post with the right code is what signs in. Nothing
// happens to the customer until then.
//
// A request with an unknown client or a redirect URI the client didn't declare is never sent back to the
// client: the person sees the error. Other mistakes go back to the redirect URI as OAuth errors.

const PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const satisfies readonly (keyof AuthorizationParams)[];

/** The authorization parameters from a query string or a form, "" for any that's missing. */
export function readAuthorizationParams(get: (name: string) => string | null | undefined): AuthorizationParams {
  const params = {} as AuthorizationParams;
  for (const name of PARAM_NAMES) {
    const value = get(name);
    params[name] = typeof value === "string" ? value : "";
  }
  return params;
}

/** The parameters as a query string, without the empty ones. */
export function authorizationQuery(params: AuthorizationParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const name of PARAM_NAMES) if (params[name] !== "") query.set(name, params[name]);
  return query;
}

/** What checking an authorization request found. */
export type AuthorizationCheck =
  /** Ask the person. `params.redirect_uri` is filled in when the client declared exactly one. */
  | { kind: "ok"; client: OAuthClient; params: AuthorizationParams }
  /** Show `message` to the person; never redirect. */
  | { kind: "error"; message: string }
  /** Send the person back to the client with this OAuth error. */
  | { kind: "redirect"; location: string };

/** The client's redirect URI with `values` and iss (RFC 9207) added to its query. */
function redirectTo(deps: SigninDeps, params: AuthorizationParams, values: Record<string, string>): string {
  const url = new URL(params.redirect_uri);
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  if (params.state !== "") url.searchParams.set("state", params.state);
  url.searchParams.set("iss", deps.baseUrl);
  return url.toString();
}

/** An OAuth error sent back to the client's redirect URI. */
export function errorRedirect(deps: SigninDeps, params: AuthorizationParams, error: string, description: string): string {
  return redirectTo(deps, params, { error, error_description: description });
}

/**
 * Check an authorization request: the client (fetching its metadata document if needed) and its redirect
 * URI, then response_type=code and PKCE with S256. Any scope is accepted; the token gets "bookings".
 */
export async function checkAuthorizationRequest(deps: SigninDeps, input: AuthorizationParams): Promise<AuthorizationCheck> {
  let client: OAuthClient;
  try {
    client = await resolveClient(deps, SIGNIN_SHOP_SLUG, input.client_id, input.redirect_uri || undefined);
  } catch (err) {
    if (err instanceof ClientError) return { kind: "error", message: err.message };
    throw err;
  }
  let params = input;
  if (params.redirect_uri === "") {
    if (client.redirectUris.length !== 1) {
      return { kind: "error", message: "redirect_uri is missing, and this client declares more than one." };
    }
    params = { ...params, redirect_uri: client.redirectUris[0] };
  }
  const refuse = (error: string, description: string): AuthorizationCheck => ({
    kind: "redirect",
    location: errorRedirect(deps, params, error, description),
  });
  if (params.response_type !== "code") {
    return refuse("unsupported_response_type", "Front Desk supports response_type=code only.");
  }
  if (params.code_challenge === "") {
    return refuse("invalid_request", "code_challenge is required: Front Desk uses PKCE with S256.");
  }
  if (params.code_challenge_method !== "S256") {
    return refuse("invalid_request", "code_challenge_method must be S256.");
  }
  return { kind: "ok", client, params };
}

/** The host the person returns to, shown next to the client's name: the redirect URI's host. */
function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

const FORM_ERRORS: readonly SigninFormError[] = [
  "invalid_name",
  "invalid_phone",
  "send_failed",
  "invalid_code",
  "code_expired",
  "internal",
];

/**
 * What /signin shows for its query: who wants access and the form, or why the request can't go on. A
 * request that would be sent back to the client (bad response_type, no PKCE) never reaches /signin from
 * the authorization endpoint; if someone opens such a link directly, it's an error here too.
 */
export async function getSigninView(
  deps: SigninDeps,
  get: (name: string) => string | null | undefined,
): Promise<SigninView> {
  const check = await checkAuthorizationRequest(deps, readAuthorizationParams(get));
  if (check.kind === "error") return { kind: "error", message: check.message };
  if (check.kind === "redirect") {
    return { kind: "error", message: "This sign-in link is incomplete. Go back to your assistant and connect Front Desk again." };
  }
  const shop = await deps.catalog.getShop(SIGNIN_SHOP_SLUG);
  const error = get("error");
  const codeId = deps.texter ? get("code_id") : null;
  const textedCode = codeId ? await deps.store.getSigninCode(codeId, deps.clock.now()) : null;
  return {
    kind: "ask",
    clientName: clientDisplayName(check.client),
    clientHost: redirectHost(check.params.redirect_uri),
    shop: { slug: SIGNIN_SHOP_SLUG, name: shop?.name ?? SIGNIN_SHOP_SLUG },
    params: check.params,
    textedCode: textedCode && { id: textedCode.id, sentTo: maskPhone(textedCode.phone) },
    // A code that has run out sends the person back to the name and number, whatever the last post said.
    error: codeId && !textedCode ? "code_expired" : (FORM_ERRORS.find((code) => code === error) ?? null),
  };
}

/** What the authorization endpoint answers. */
export type AuthorizeResponse = { status: 302 | 303; location: string } | { status: 400; message: string };

/** GET /api/oauth/authorize: check the request, then send the person to /signin with the same parameters. */
export async function startAuthorization(deps: SigninDeps, params: AuthorizationParams): Promise<AuthorizeResponse> {
  const check = await checkAuthorizationRequest(deps, params);
  if (check.kind === "error") return { status: 400, message: check.message };
  if (check.kind === "redirect") return { status: 302, location: check.location };
  return { status: 302, location: `${deps.baseUrl}${SIGNIN_PATH}?${authorizationQuery(check.params)}` };
}

/** A new authorization code: "fdc_" and 32 random bytes, base64url. */
function newCode(): string {
  return `fdc_${randomBytes(32).toString("base64url")}`;
}

/**
 * Store a new code for this person and text it to their number. Returns its id, or null when the text
 * didn't go through (the provider's message is logged, not shown, since it can name the number).
 */
async function textSigninCode(deps: SigninDeps, texter: TextSender, name: string, phone: string): Promise<string | null> {
  const code = newTextedCode();
  const expiresAt = new Date(deps.clock.now().getTime() + TEXTED_CODE_SECONDS * 1000);
  // Stored first, so a code that arrives always works.
  const stored = await deps.store.createSigninCode({ shopSlug: SIGNIN_SHOP_SLUG, code, phone, name, expiresAt });
  const shop = await deps.catalog.getShop(SIGNIN_SHOP_SLUG);
  try {
    await texter.send(phone, signinCodeText(code, shop?.name ?? SIGNIN_SHOP_SLUG));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "oauth.signin_code_text_failed",
        shop: SIGNIN_SHOP_SLUG,
        provider: texter.provider,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
  return stored.id;
}

/** Enter a texted code: who it was texted to, or null. Spaces are ignored; anything but six digits is simply wrong. */
async function enterSigninCode(deps: SigninDeps, codeId: string, given: unknown): Promise<{ name: string; phone: string } | null> {
  const code = typeof given === "string" ? given.replace(/\s+/g, "") : "";
  if (!/^[0-9]{6}$/.test(code)) return null;
  return deps.store.useSigninCode(codeId, code, deps.clock.now());
}

/**
 * POST /api/oauth/authorize, the /signin form: `decision` "allow" (with name and phone) or "deny". Allow
 * finds or creates the customer by (shop, phone), stores a code (10 minutes, PKCE challenge, redirect URI)
 * and sends the person back to the client with it. A name or number that doesn't work sends them back to
 * /signin with ?error=invalid_name or invalid_phone (nothing personal in the URL).
 *
 * Where texting is on, Allow with a name and number only texts the code and sends them back to /signin to
 * enter it. Allow with `codeId` and the right `code` is the only way to sign in; the name and number are the
 * ones the code was texted for, never the form's.
 */
export async function answerAuthorization(
  deps: SigninDeps,
  form: { params: AuthorizationParams; decision: string; name: unknown; phone: unknown; codeId?: unknown; code?: unknown },
): Promise<AuthorizeResponse> {
  const check = await checkAuthorizationRequest(deps, form.params);
  if (check.kind === "error") return { status: 400, message: check.message };
  if (check.kind === "redirect") return { status: 303, location: check.location };
  const { params, client } = check;

  if (form.decision !== "allow") {
    return { status: 303, location: errorRedirect(deps, params, "access_denied", "The person didn't allow access.") };
  }
  /** Back to /signin: asking for the code when `codeId` is given, else for the name and number. */
  const toSignin = (extra: { error?: SigninFormError; codeId?: string }) => {
    const query = authorizationQuery(params);
    if (extra.codeId) query.set("code_id", extra.codeId);
    if (extra.error) query.set("error", extra.error);
    return { status: 303 as const, location: `${deps.baseUrl}${SIGNIN_PATH}?${query}` };
  };

  let person: { name: string; phone: string } | null;
  if (deps.texter && typeof form.codeId === "string" && form.codeId !== "") {
    person = await enterSigninCode(deps, form.codeId, form.code);
    if (!person) return toSignin({ error: "invalid_code", codeId: form.codeId });
  } else {
    const name = parseCustomerName(form.name);
    if (!name) return toSignin({ error: "invalid_name" });
    const phone = parseMobile(form.phone);
    if (!phone) return toSignin({ error: "invalid_phone" });
    if (deps.texter) {
      const codeId = await textSigninCode(deps, deps.texter, name, phone);
      return codeId ? toSignin({ codeId }) : toSignin({ error: "send_failed" });
    }
    person = { name, phone };
  }

  const customer = await signInCustomer(deps.store, SIGNIN_SHOP_SLUG, person.name, person.phone);
  const code = newCode();
  await deps.store.createCode({
    code,
    shopSlug: SIGNIN_SHOP_SLUG,
    clientId: client.clientId,
    customerId: customer.id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    scope: SCOPE,
    resource: params.resource || null,
    expiresAt: new Date(deps.clock.now().getTime() + CODE_SECONDS * 1000),
  });
  return { status: 303, location: redirectTo(deps, params, { code }) };
}
