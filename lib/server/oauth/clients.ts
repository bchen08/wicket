import { randomBytes } from "node:crypto";
import type { ClientRegistrationRequest, ClientRegistrationResponse } from "../../types/oauth";
import type { SigninDeps } from "./deps";
import type { OAuthClient } from "./store";

// Who is asking: OAuth clients. Two kinds, as the MCP authorization spec orders them:
//   - Client ID Metadata Documents (preferred): the client_id is an HTTPS URL; Front Desk fetches the JSON
//     document there (client_id, client_name, redirect_uris) and caches it for an hour.
//   - Dynamic Client Registration (RFC 7591, the fallback): POST /api/oauth/register returns a client_id.
// Every client is public: PKCE instead of a secret.

/** A client or redirect URI Front Desk can't accept. Never redirected to the client: shown to the person. */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

/** A registration request Front Desk can't accept (RFC 7591 error codes). */
export class RegistrationError extends Error {
  constructor(
    readonly code: "invalid_redirect_uri" | "invalid_client_metadata",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

/** How long a fetched metadata document is reused before it's fetched again. */
export const METADATA_CACHE_MS = 60 * 60 * 1000;
/** How long Front Desk waits for a metadata document. */
const METADATA_FETCH_MS = 5_000;
/** Longest client_name stored. */
const MAX_CLIENT_NAME = 100;

/** true for a client_id that names a Client ID Metadata Document: an https URL with a path and no fragment. */
export function isMetadataDocumentUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.pathname !== "/" && url.hash === "" && url.href === clientId;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether `requested` is one of the client's redirect URIs: an exact match, or for loopback http URIs
 * (localhost, 127.0.0.1, [::1]) the same URI on any port (RFC 8252 section 7.3; Claude Code and other
 * native clients pick a free port per sign-in).
 */
export function redirectUriAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !LOOPBACK_HOSTS.has(want.hostname)) return false;
  return registered.some((uri) => {
    try {
      const have = new URL(uri);
      return (
        have.protocol === "http:" &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname &&
        have.search === want.search
      );
    } catch {
      return false;
    }
  });
}

/** Strings only, trimmed, without control characters; null if there's nothing left. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, MAX_CLIENT_NAME);
  return name === "" ? null : name;
}

/** The redirect URIs a client declared, checked: a non-empty array of absolute URLs without fragments. */
function parseRedirectUris(value: unknown, fail: (message: string) => Error): string[] {
  if (!Array.isArray(value) || value.length === 0) throw fail("redirect_uris must be a non-empty array of URLs.");
  return value.map((uri) => {
    if (typeof uri !== "string" || uri.includes("\u0000")) throw fail("Each redirect URI must be a URL string.");
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw fail(`"${uri}" is not an absolute URL.`);
    }
    if (url.hash !== "") throw fail(`"${uri}" has a fragment; redirect URIs can't.`);
    return uri;
  });
}

/** Fetch and check the Client ID Metadata Document at `clientId`. */
async function fetchMetadataDocument(deps: SigninDeps, shopSlug: string, clientId: string): Promise<OAuthClient> {
  let body: unknown;
  try {
    const res = await deps.fetch(clientId, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(METADATA_FETCH_MS),
    });
    if (!res.ok) throw new ClientError(`The client's metadata document at ${clientId} answered HTTP ${res.status}.`);
    body = await res.json();
  } catch (err) {
    if (err instanceof ClientError) throw err;
    throw new ClientError(`Couldn't read the client's metadata document at ${clientId}.`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ClientError(`The client's metadata document at ${clientId} isn't a JSON object.`);
  }
  const doc = body as Record<string, unknown>;
  if (doc.client_id !== clientId) {
    throw new ClientError(`The client's metadata document at ${clientId} names a different client_id.`);
  }
  const redirectUris = parseRedirectUris(
    doc.redirect_uris,
    (message) => new ClientError(`The client's metadata document at ${clientId} is invalid: ${message}`),
  );
  return {
    shopSlug,
    clientId,
    kind: "cimd",
    clientName: cleanName(doc.client_name),
    redirectUris,
    fetchedAt: deps.clock.now(),
  };
}

/**
 * The client asking, with `redirectUri` checked against its redirect URIs (when given). A metadata document
 * is fetched when it isn't cached, is older than an hour, or doesn't list `redirectUri` (it may have
 * changed); a registered client must exist. Throws ClientError.
 */
export async function resolveClient(
  deps: SigninDeps,
  shopSlug: string,
  clientId: string,
  redirectUri?: string,
): Promise<OAuthClient> {
  if (clientId === "" || clientId.includes("\u0000")) throw new ClientError("client_id is missing.");
  const cached = await deps.store.getClient(shopSlug, clientId);
  const fits = (c: OAuthClient) => redirectUri === undefined || redirectUriAllowed(c.redirectUris, redirectUri);

  if (isMetadataDocumentUrl(clientId)) {
    const fresh = cached && deps.clock.now().getTime() - cached.fetchedAt.getTime() < METADATA_CACHE_MS;
    if (cached && fresh && fits(cached)) return cached;
    const client = await fetchMetadataDocument(deps, shopSlug, clientId);
    await deps.store.saveClient(client);
    if (!fits(client)) throw new ClientError(`${redirectUri} isn't one of this client's redirect URIs.`);
    return client;
  }
  if (!cached || cached.kind !== "registered") {
    throw new ClientError(
      "Unknown client_id. Use a Client ID Metadata Document URL as client_id, or register at /api/oauth/register first.",
    );
  }
  if (!fits(cached)) throw new ClientError(`${redirectUri} isn't one of this client's redirect URIs.`);
  return cached;
}

/** The name shown on /signin: the client's own name, or its host. */
export function clientDisplayName(client: OAuthClient): string {
  if (client.clientName) return client.clientName;
  try {
    return new URL(client.kind === "cimd" ? client.clientId : (client.redirectUris[0] ?? "")).host || "An app";
  } catch {
    return "An app";
  }
}

/**
 * POST /api/oauth/register (RFC 7591): register a public client and return its id. Only redirect_uris is
 * required; client_name is kept; everything else is answered with what Front Desk supports (authorization
 * code with PKCE, refresh tokens, no client secret). Throws RegistrationError.
 */
export async function registerClient(
  deps: SigninDeps,
  shopSlug: string,
  body: unknown,
): Promise<ClientRegistrationResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RegistrationError("invalid_client_metadata", "The registration request must be a JSON object.");
  }
  const request = body as Partial<Record<keyof ClientRegistrationRequest, unknown>>;
  const redirectUris = parseRedirectUris(request.redirect_uris, (message) => new RegistrationError("invalid_redirect_uri", message));
  const now = deps.clock.now();
  const client: OAuthClient = {
    shopSlug,
    clientId: `fd_client_${randomBytes(16).toString("base64url")}`,
    kind: "registered",
    clientName: cleanName(request.client_name),
    redirectUris,
    fetchedAt: now,
  };
  await deps.store.saveClient(client);
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(client.clientName ? { client_name: client.clientName } : {}),
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
