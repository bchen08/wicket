import type { AgentKeyCache } from "./client";
import { PapError } from "./errors";
import { decodeJwt, jwkThumbprint, verifySignature, type Jwk, type JwsAlgorithm } from "./jwt";

// verifySession: PAP 0.4's Session header check (sections 5.2 and 5.3), as much of it as identifies the agent.
//
// Checked: Poppy-Version is 0.4; the Session JWT and its delegation are the right kinds of JWT; the delegation
// is signed by a key at the agent's jwks_uri and hasn't expired (at most 24 hours long); the Session JWT is
// signed by the delegated key it names (kid = that key's thumbprint), is for this Company (aud) and was signed
// within the last minute or so (iat). Not checked (MVP: no hardening): htm and htu, replayed jti, ath (Front
// Desk issues no access tokens), session continuity (sub and agent_id per sid), and the address checks on the
// URLs fetched. See docs/agent-identity.md.

/** The protocol version Front Desk implements and serves. */
export const PAP_VERSION = "0.4";

/** Request headers (lowercase, as Headers.get reads them). */
export const SESSION_HEADER = "poppy-session";
export const VERSION_HEADER = "poppy-version";

/** A Session JWT is accepted this long after its iat (PAP has no exp on it; the guides suggest about a minute)… */
export const IAT_WINDOW_SECONDS = 60;
/** …give or take this much clock difference between the agent and Front Desk. */
export const CLOCK_SKEW_SECONDS = 30;
/** A delegation's exp is at most this long after its iat. */
export const MAX_DELEGATION_SECONDS = 24 * 3600;

/** What a verified Session header says. */
export type VerifiedSession = {
  /** The agent's client_id (the JWTs' iss). */
  clientId: string;
  /** client_name from its client metadata. */
  clientName: string;
  /** The Session ID. */
  sid: string;
  /** The User ID the agent gave this User at Front Desk. */
  sub: string;
  /** The optional Agent ID. */
  agentId?: string;
};

export type VerifySessionOptions = {
  /** Front Desk's Company identifier: `https://<host>` (companyIdentifier in discovery.ts). aud must equal it. */
  audience: string;
  /** Where the agent's metadata and keys come from (cached). */
  keys: AgentKeyCache;
  /** Now, in milliseconds since the epoch. Real time: a frozen FRONTDESK_NOW must not expire every session. */
  now: number;
};

const invalid = (message: string) => new PapError("invalid_session", message);

const isString = (value: unknown): value is string => typeof value === "string" && value !== "";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Whether `version` ("major.minor") is compatible with 0.4: before 1.0, that means the same minor version too. */
export function compatibleVersion(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)$/.exec(version?.trim() ?? "");
  return match !== null && `${Number(match[1])}.${Number(match[2])}` === PAP_VERSION;
}

/** The Session JWT in the header, with what verification needs from it. */
function readSessionJwt(header: string) {
  const jwt = decodeJwt(header);
  if (!jwt) throw invalid("Poppy-Session must be a compact JWT (three base64url parts).");
  const { typ, alg, kid, poppy_dlg } = jwt.header;
  if (typ !== "poppy-session+jwt") throw invalid('The Session JWT\'s typ must be "poppy-session+jwt".');
  if (alg !== "ES256") throw invalid('The Session JWT\'s alg must be "ES256".');
  if (!isString(kid)) throw invalid("The Session JWT needs a kid: its delegated key's JWK thumbprint.");
  if (!isString(poppy_dlg)) throw invalid("The Session JWT needs poppy_dlg: the delegation for its key. Sign it with a delegated key.");
  const { iss, aud, sid, sub, iat, agent_id } = jwt.payload;
  if (!isString(iss)) throw invalid("The Session JWT needs iss: your client_id.");
  if (!isString(aud)) throw invalid("The Session JWT needs aud: the Company's identifier.");
  if (!isString(sid)) throw invalid("The Session JWT needs sid: the Session ID.");
  if (!isString(sub)) throw invalid("The Session JWT needs sub: the User ID.");
  if (!isTime(iat)) throw invalid("The Session JWT needs iat, in Unix seconds.");
  return { jwt, kid, delegation: poppy_dlg, iss, aud, sid, sub, iat, agentId: isString(agent_id) ? agent_id : undefined };
}

/** The delegation in poppy_dlg, with what verification needs from it. */
function readDelegation(compact: string, iss: string) {
  const jwt = decodeJwt(compact);
  if (!jwt) throw invalid("poppy_dlg must be a compact JWT.");
  const { typ, alg, kid } = jwt.header;
  if (typ !== "poppy-delegation+jwt") throw invalid('The delegation\'s typ must be "poppy-delegation+jwt".');
  if (alg !== "ES256" && alg !== "PS384") throw invalid('The delegation\'s alg must be "ES256" or "PS384".');
  if (!isString(kid)) throw invalid("The delegation needs a kid: the key in your jwks_uri that signed it.");
  const { iss: dlgIss, cnf, iat, exp } = jwt.payload;
  if (dlgIss !== iss) throw invalid("The delegation's iss must be the Session JWT's iss.");
  const key = (cnf as { jwk?: unknown } | undefined)?.jwk as Jwk | undefined;
  if (!key || typeof key !== "object" || typeof key.kty !== "string") throw invalid("The delegation needs cnf.jwk: the delegated public key.");
  if (!isTime(iat) || !isTime(exp)) throw invalid("The delegation needs iat and exp, in Unix seconds.");
  return { jwt, alg: alg as JwsAlgorithm, kid, delegatedKey: key, iat, exp };
}

/** The key in the agent's jwks_uri named `kid`. An unknown kid fetches the key set again once (the agent may have rotated keys). */
async function signingKey(keys: AgentKeyCache, clientId: string, kid: string) {
  const find = (k: { keys: Jwk[] }) => k.keys.find((key) => key.kid === kid);
  let agent = await keys.get(clientId);
  let key = find(agent);
  if (!key) {
    agent = await keys.get(clientId, { fresh: true });
    key = find(agent);
  }
  if (!key) throw invalid(`No key with kid "${kid}" in the agent's jwks_uri.`);
  return { key, name: agent.metadata.name };
}

/**
 * Verify a request's Poppy-Session header. Returns what it says about the agent, or throws PapError:
 * version_unsupported (Poppy-Version missing or not 0.4) or invalid_session (any other failure; the message
 * says what to fix). Call it only when the header is present.
 */
export async function verifySession(headers: Headers, options: VerifySessionOptions): Promise<VerifiedSession> {
  const header = headers.get(SESSION_HEADER);
  if (!header) throw invalid("The request has no Poppy-Session header.");
  if (!compatibleVersion(headers.get(VERSION_HEADER))) {
    throw new PapError("version_unsupported", `Send Poppy-Version: ${PAP_VERSION} with the Session header. Front Desk serves PAP ${PAP_VERSION}.`);
  }

  const session = readSessionJwt(header);
  const delegation = readDelegation(session.delegation, session.iss);
  const nowSeconds = Math.floor(options.now / 1000);

  // The claims first: they need no network.
  if (session.aud !== options.audience) {
    throw invalid(`The Session JWT's aud must be ${options.audience}, the Company's identifier (https:// + organization.domain in poppy.json).`);
  }
  if (session.iat < nowSeconds - IAT_WINDOW_SECONDS - CLOCK_SKEW_SECONDS || session.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw invalid(`The Session JWT's iat is outside the ${IAT_WINDOW_SECONDS}-second window. Sign a new Session JWT for each request.`);
  }
  if (delegation.exp <= nowSeconds - CLOCK_SKEW_SECONDS) throw invalid("The delegation has expired. Get a new delegation for your key.");
  if (delegation.exp - delegation.iat > MAX_DELEGATION_SECONDS) throw invalid("The delegation's exp must be at most 24 hours after its iat.");

  // 1. The delegation, signed by a key at the agent's jwks_uri.
  const { key, name } = await signingKey(options.keys, session.iss, delegation.kid);
  if (!(await verifySignature(delegation.jwt, key, delegation.alg))) {
    throw invalid(`The delegation's signature doesn't verify with key "${delegation.kid}" from the agent's jwks_uri.`);
  }
  // 2. The Session JWT, signed by the delegated key, which its kid names by thumbprint.
  if ((await jwkThumbprint(delegation.delegatedKey)) !== session.kid) {
    throw invalid("The Session JWT's kid must be the JWK thumbprint (RFC 7638) of the delegation's cnf.jwk.");
  }
  if (!(await verifySignature(session.jwt, delegation.delegatedKey, "ES256"))) {
    throw invalid("The Session JWT's signature doesn't verify with the delegated key (cnf.jwk).");
  }

  return { clientId: session.iss, clientName: name, sid: session.sid, sub: session.sub, ...(session.agentId ? { agentId: session.agentId } : {}) };
}
