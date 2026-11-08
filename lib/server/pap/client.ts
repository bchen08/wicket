import { PapError } from "./errors";
import type { Jwk } from "./jwt";

// A PAP agent's identity: its client metadata document (fetched from its client_id) and the public keys at
// its jwks_uri (PAP 0.4 section 4.1), cached for 10 minutes.
//
// client_id is normally an HTTPS URL. Front Desk also accepts a data: URL (base64 or percent-encoded JSON),
// whose jwks_uri may be a data: URL too, so a demo agent can identify itself without hosting anything
// (scripts/demo-pap-agent.mjs). PAP 0.4 requires HTTPS here; data: URLs are Front Desk's own addition.

/** How long a fetched client metadata document and key set are used before fetching them again. */
export const AGENT_KEYS_TTL_MS = 10 * 60_000;

/** How long one fetch may take. */
const FETCH_TIMEOUT_MS = 5_000;

/** The longest agent name kept: the same limit as Booking.agent.name everywhere else. */
export const MAX_AGENT_NAME = 80;

/** What Front Desk uses from an agent's client metadata. */
export type ClientMetadata = {
  clientId: string;
  /** client_name, without control characters, trimmed, at most 80 characters. */
  name: string;
  jwksUri: string;
};

/** An agent's metadata and the public keys at its jwks_uri. */
export type AgentKeys = { metadata: ClientMetadata; keys: Jwk[] };

/** Reads a JSON document from a URL the agent gave. Throws PapError("invalid_session") when it can't. */
export type FetchJson = (url: string, options: { followRedirects: boolean }) => Promise<unknown>;

export type AgentKeyCache = {
  /** The agent's metadata and keys: from the cache while it is under 10 minutes old, unless `fresh`. */
  get(clientId: string, options?: { fresh?: boolean }): Promise<AgentKeys>;
};

const refuse = (message: string) => new PapError("invalid_session", message);

/** The scheme Front Desk accepts for a URL the agent gave: https: or data:. */
function acceptedScheme(url: string): "https:" | "data:" | null {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "data:" ? protocol : null;
  } catch {
    return null;
  }
}

/** The JSON in a data: URL (`data:[<type>][;base64],<data>`). */
function parseDataUrl(url: string): unknown {
  const comma = url.indexOf(",");
  if (comma === -1) throw refuse("A data: URL needs a comma before its data.");
  const meta = url.slice("data:".length, comma);
  const data = url.slice(comma + 1);
  const text = /;base64$/i.test(meta) ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
  try {
    return JSON.parse(text);
  } catch {
    throw refuse("The data: URL doesn't hold JSON.");
  }
}

/** The default FetchJson: decodes data: URLs, and GETs https: ones (5-second timeout, no credentials). */
export const fetchJson: FetchJson = async (url, { followRedirects }) => {
  const scheme = acceptedScheme(url);
  if (scheme === "data:") return parseDataUrl(url);
  if (scheme !== "https:") throw refuse(`${url.slice(0, 80)} isn't an HTTPS URL.`);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: followRedirects ? "follow" : "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw refuse(`Couldn't fetch ${url}: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (res.status !== 200) throw refuse(`${url} answered HTTP ${res.status}, not 200.`);
  try {
    return await res.json();
  } catch {
    throw refuse(`${url} didn't return JSON.`);
  }
};

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/** The client metadata document's fields Front Desk needs, checked. */
function readMetadata(clientId: string, doc: unknown): ClientMetadata {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw refuse("The client metadata isn't a JSON object.");
  const d = doc as Record<string, unknown>;
  // A data: client_id can't contain itself, so only an HTTPS document must name its own URL.
  if (acceptedScheme(clientId) === "https:" && d.client_id !== clientId) {
    throw refuse(`The client metadata's client_id must be ${clientId}, the URL it was fetched from.`);
  }
  const name = typeof d.client_name === "string" ? d.client_name.replace(CONTROL_CHARACTERS, "").trim().slice(0, MAX_AGENT_NAME).trim() : "";
  if (name === "") throw refuse("The client metadata has no client_name.");
  if (typeof d.jwks_uri !== "string" || acceptedScheme(d.jwks_uri) === null) {
    throw refuse("The client metadata's jwks_uri must be an HTTPS URL.");
  }
  return { clientId, name, jwksUri: d.jwks_uri };
}

/** The public keys in a JWK Set. */
function readKeys(doc: unknown): Jwk[] {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw refuse("The jwks_uri document isn't a JWK Set (no keys array).");
  return keys.filter((k): k is Jwk => !!k && typeof k === "object" && typeof (k as Jwk).kty === "string");
}

/**
 * A cache of agents' metadata and keys, one entry per client_id, each used for `ttlMs` (10 minutes) after it
 * was fetched. `fetch` and `now` are there for tests.
 */
export function createAgentKeyCache({
  fetch = fetchJson,
  now = Date.now,
  ttlMs = AGENT_KEYS_TTL_MS,
}: { fetch?: FetchJson; now?: () => number; ttlMs?: number } = {}): AgentKeyCache {
  const entries = new Map<string, { fetchedAt: number; value: AgentKeys }>();

  async function load(clientId: string): Promise<AgentKeys> {
    if (acceptedScheme(clientId) === null) throw refuse("iss must be the agent's client_id: an HTTPS URL.");
    // The client metadata without following redirects, as the CIMD draft requires; the key set normally.
    const metadata = readMetadata(clientId, await fetch(clientId, { followRedirects: false }));
    const keys = readKeys(await fetch(metadata.jwksUri, { followRedirects: true }));
    return { metadata, keys };
  }

  return {
    async get(clientId, { fresh = false } = {}) {
      const cached = entries.get(clientId);
      if (cached && !fresh && now() - cached.fetchedAt < ttlMs) return cached.value;
      const value = await load(clientId);
      entries.set(clientId, { fetchedAt: now(), value });
      return value;
    },
  };
}
