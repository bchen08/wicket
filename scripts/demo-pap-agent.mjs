#!/usr/bin/env node
// node scripts/demo-pap-agent.mjs <base-url> [--bypass <secret>] [--name <agent name>] [--customer <name>] [--new-key]
//
// A demo PAP 0.4 agent (Personal Agent Protocol, "Poppy"). It books a Beard trim at Hart's through Front Desk's
// MCP endpoint with a signed Poppy-Session header, so the booking shows the agent as confirmed, then prints the
// approval link. Node 20+ and nothing else: no dependencies, no repo code imported. See docs/agent-identity.md.
//
// 1. Identity: an ES256 key pair, kept in <tmpdir>/front-desk-demo-pap-agent.json so every run is the same agent
//    (--new-key makes a new one: a new agent). Its JWK Set and client metadata are published as data: URLs, and
//    the client metadata's data: URL is its client_id. PAP 0.4 wants an HTTPS client_id; a preview can't reach a
//    server on this computer, so Front Desk also accepts data: URLs (lib/server/pap/client.ts).
// 2. Discovery: GET <base>/.well-known/poppy.json → the MCP endpoint, and the Company identifier
//    https://<organization.domain>, which every Session JWT names as its aud.
// 3. Session: a new delegated key, vouched for by a delegation the identity key signs (1 hour), a random sid and
//    User ID. Each MCP request carries a fresh Session JWT signed by the delegated key, and Poppy-Version: 0.4.
// 4. Booking: get_availability for beard-trim over the next 6 days, book a random start, print the link.
//
// --bypass <secret> (or VERCEL_AUTOMATION_BYPASS_SECRET) sends Vercel's x-vercel-protection-bypass header, for
// previews behind Vercel Authentication. Exit codes: 0 booked, 1 failed, 64 bad arguments.
// Smoke (scripts/smoke-checks/agents.mjs) and the server's tests (lib/server/pap) use the exports below.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEMO_AGENT_NAME = "Front Desk demo agent";
export const DEMO_CUSTOMER = "Demo Customer";
export const PAP_VERSION = "0.4";
export const BYPASS_HEADER = "x-vercel-protection-bypass";
/** Where the identity key is kept between runs. */
export const DEFAULT_KEY_FILE = join(tmpdir(), "front-desk-demo-pap-agent.json");

const MCP_PROTOCOL = "2026-07-28";
const BOOKING_WINDOW_DAYS = 6;
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE =
  "Usage: node scripts/demo-pap-agent.mjs <base-url> [--bypass <secret>] [--name <agent name>] [--customer <name>] [--new-key]";

const subtle = globalThis.crypto.subtle;
const ES256 = { name: "ECDSA", namedCurve: "P-256" };

// ---- Keys and JWTs ----

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const encodeJson = (value) => base64url(Buffer.from(JSON.stringify(value)));
/** At least 128 random bits, base64url: jti, sid and User IDs. */
const randomId = (bytes = 16) => base64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

/** The public members of an EC key. */
export const publicJwk = ({ kty, crv, x, y }) => ({ kty, crv, x, y });

/** A new ES256 key pair as JWKs: { privateJwk, publicJwk }. */
export async function generateKeyPair() {
  const pair = await subtle.generateKey(ES256, true, ["sign", "verify"]);
  return { privateJwk: await subtle.exportKey("jwk", pair.privateKey), publicJwk: publicJwk(await subtle.exportKey("jwk", pair.publicKey)) };
}

/** An EC key's JWK thumbprint (RFC 7638, SHA-256, base64url). */
export async function thumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return base64url(new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

/** A compact JWT signed with ES256 by `privateJwk`. */
export async function signJwt(header, payload, privateJwk) {
  const key = await subtle.importKey("jwk", privateJwk, ES256, false, ["sign"]);
  const input = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

/** JSON as a base64 data: URL. */
export const dataUrl = (value) => `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString("base64")}`;

// ---- Identity, delegation, session ----

/**
 * The agent's identity: its client_id (a data: URL of its client metadata, whose jwks_uri is a data: URL of its
 * JWK Set) and the key that signs its delegations. Pass `identityKey` to be the same agent again.
 */
export async function createIdentity({ name = DEMO_AGENT_NAME, identityKey } = {}) {
  const key = identityKey ?? (await generateKeyPair());
  const kid = await thumbprint(key.publicJwk);
  const jwks = { keys: [{ ...publicJwk(key.publicJwk), kid, alg: "ES256", use: "sig" }] };
  const metadata = {
    client_name: name,
    jwks_uri: dataUrl(jwks),
    redirect_uris: [],
    token_endpoint_auth_method: "private_key_jwt",
  };
  return { clientId: dataUrl(metadata), name, kid, identityKey: key };
}

/** The identity key in `file`, or a new one written there (or always a new one with `fresh`). */
export async function loadIdentityKey(file = DEFAULT_KEY_FILE, { fresh = false } = {}) {
  if (!fresh) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved?.privateJwk?.d && saved?.publicJwk?.x) return saved;
    } catch {
      // No key yet (or an unreadable one): make one.
    }
  }
  const key = await generateKeyPair();
  writeFileSync(file, JSON.stringify(key), { mode: 0o600 });
  return key;
}

/** A new delegated key and the delegation for it, signed by the identity key, valid for `lifetimeSeconds`. */
export async function delegate(identity, { now = Date.now(), lifetimeSeconds = 3600 } = {}) {
  const delegated = await generateKeyPair();
  const iat = Math.floor(now / 1000);
  const jwt = await signJwt(
    { alg: "ES256", typ: "poppy-delegation+jwt", kid: identity.kid },
    { iss: identity.clientId, cnf: { jwk: delegated.publicJwk }, iat, exp: iat + lifetimeSeconds, jti: randomId() },
    identity.identityKey.privateJwk,
  );
  return { jwt, key: delegated, kid: await thumbprint(delegated.publicJwk) };
}

/** A Session JWT for one request (`method` and `url`), signed by the delegated key. */
export async function sessionJwt({ identity, delegation, audience, sid, sub, method, url, now = Date.now() }) {
  const target = new URL(url);
  return signJwt(
    { typ: "poppy-session+jwt", alg: "ES256", kid: delegation.kid, poppy_dlg: delegation.jwt },
    {
      iss: identity.clientId,
      aud: audience,
      sid,
      sub,
      htm: method,
      htu: `${target.origin}${target.pathname}`,
      iat: Math.floor(now / 1000),
      jti: randomId(),
    },
    delegation.key.privateJwk,
  );
}

/** A PAP Session at one Company: `headers(method, url)` are the Poppy headers for one request in it. */
export async function openSession({ identity, audience, now = Date.now }) {
  const delegation = await delegate(identity, { now: now() });
  const sid = randomId();
  const sub = `usr_${randomId(12)}`;
  return {
    sid,
    sub,
    delegation,
    async headers(method, url) {
      const jwt = await sessionJwt({ identity, delegation, audience, sid, sub, method, url, now: now() });
      return { "poppy-session": jwt, "poppy-version": PAP_VERSION };
    },
  };
}

// ---- Front Desk ----

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The JSON-RPC message in an MCP response: plain JSON, or the first SSE event carrying a result or error. */
function mcpMessage(text) {
  const direct = tryJson(text);
  if (direct) return direct;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    const msg = tryJson(data);
    if (msg && ("result" in msg || "error" in msg)) return msg;
  }
  throw new Error(`unreadable MCP response: ${text.slice(0, 200)}`);
}

/** GET <base>/.well-known/poppy.json → { doc, mcpUrl, audience }. */
export async function discover(baseUrl, { fetch = globalThis.fetch, bypass = undefined } = {}) {
  const res = await fetch(new URL("/.well-known/poppy.json", baseUrl).href, {
    headers: { accept: "application/json", ...(bypass ? { [BYPASS_HEADER]: bypass } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const doc = tryJson(await res.text());
  if (res.status !== 200 || !doc) throw new Error(`poppy.json: HTTP ${res.status}`);
  if (doc.protocol_version !== PAP_VERSION) throw new Error(`poppy.json is PAP ${doc.protocol_version}, not ${PAP_VERSION}`);
  const mcpUrl = doc.apis?.find((a) => a?.type === "mcp")?.url;
  if (typeof mcpUrl !== "string") throw new Error("poppy.json lists no MCP API");
  if (typeof doc.organization?.domain !== "string") throw new Error("poppy.json has no organization.domain");
  return { doc, mcpUrl, audience: `https://${doc.organization.domain.toLowerCase()}` };
}

/**
 * An MCP client for `mcpUrl` whose every request carries the Session's Poppy headers. `callTool(name, args)` →
 * { value } (structuredContent), { error } (the tool's ApiError), or { status, body } when Front Desk refused the
 * request itself (e.g. 400 invalid_session).
 */
export function papMcpClient({ mcpUrl, session, name, fetch = globalThis.fetch, bypass = undefined }) {
  let nextId = 1;
  return {
    async callTool(tool, args) {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL,
          "mcp-method": "tools/call",
          "mcp-name": tool,
          ...(await session.headers("POST", mcpUrl)),
          ...(bypass ? { [BYPASS_HEADER]: bypass } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: {
            name: tool,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name, version: "1.0.0" },
            },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status !== 200) return { status: res.status, body: tryJson(text) ?? text };
      const msg = mcpMessage(text);
      if (msg.error) throw new Error(`MCP ${tool}: ${JSON.stringify(msg.error)}`);
      const result = msg.result;
      const content = result?.content?.[0]?.text ?? "";
      if (result?.isError) return { error: tryJson(content)?.error ?? { code: "unknown", message: content } };
      return { value: result?.structuredContent, text: content };
    },
  };
}

const rfc3339 = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Discover Front Desk at `baseUrl`, open a PAP Session as `identity` and book a `service` (Beard trim) at a random
 * open start in the next 6 days for `customer`. Returns { booking, identity, mcpUrl, audience }; throws on failure.
 */
export async function bookAsPapAgent({
  baseUrl,
  identity,
  customer = DEMO_CUSTOMER,
  service = "beard-trim",
  fetch = globalThis.fetch,
  bypass = undefined,
  now = Date.now,
  random = Math.random,
}) {
  const { mcpUrl, audience } = await discover(baseUrl, { fetch, bypass });
  const session = await openSession({ identity, audience, now });
  const client = papMcpClient({ mcpUrl, session, name: identity.name, fetch, bypass });
  const refused = (step, r) => new Error(`${step}: HTTP ${r.status} ${JSON.stringify(r.body)}`);

  const from = now();
  const avail = await client.callTool("get_availability", {
    service_id: service,
    from: rfc3339(from),
    to: rfc3339(from + BOOKING_WINDOW_DAYS * 24 * 3600_000),
    limit: 50,
  });
  if (avail.status) throw refused("get_availability", avail);
  if (avail.error) throw new Error(`get_availability: ${JSON.stringify(avail.error)}`);
  const slots = avail.value?.slots ?? [];
  if (slots.length === 0) throw new Error(`no open ${service} starts in the next ${BOOKING_WINDOW_DAYS} days`);
  const slot = slots[Math.floor(random() * slots.length)];

  const booked = await client.callTool("book", { service_id: service, start: slot.start, customer_name: customer });
  if (booked.status) throw refused("book", booked);
  if (booked.error) throw new Error(`book ${slot.start}: ${JSON.stringify(booked.error)}`);
  return { booking: booked.value.booking, identity, mcpUrl, audience };
}

// ---- Command line ----

/** The options from the command line, or { error }. */
export function parseArgs(argv, env = {}) {
  const options = { newKey: false };
  const flags = { "--bypass": "bypass", "--name": "name", "--customer": "customer" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { error: USAGE };
    if (arg === "--new-key") {
      options.newKey = true;
    } else if (flags[arg]) {
      const value = argv[++i];
      if (value === undefined || value === "") return { error: `${arg} needs a value.\n${USAGE}` };
      options[flags[arg]] = value;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}.\n${USAGE}` };
    } else if (options.baseUrl === undefined) {
      options.baseUrl = arg;
    } else {
      return { error: `Unexpected argument ${arg}.\n${USAGE}` };
    }
  }
  if (!options.baseUrl) return { error: USAGE };
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(options.baseUrl);
  try {
    options.baseUrl = new URL(/^https?:\/\//i.test(options.baseUrl) ? options.baseUrl : `${local ? "http" : "https"}://${options.baseUrl}`).origin;
  } catch {
    return { error: `${options.baseUrl} isn't a URL.\n${USAGE}` };
  }
  options.bypass ??= env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || undefined;
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.error) {
    console.error(options.error);
    process.exit(64);
  }
  const identityKey = await loadIdentityKey(DEFAULT_KEY_FILE, { fresh: options.newKey });
  const identity = await createIdentity({ name: options.name ?? DEMO_AGENT_NAME, identityKey });
  console.log(`Agent: ${identity.name} (key ${identity.kid.slice(0, 12)}…, kept in ${DEFAULT_KEY_FILE})`);
  const { booking, mcpUrl } = await bookAsPapAgent({ baseUrl: options.baseUrl, identity, customer: options.customer, bypass: options.bypass });
  const agent = booking.agent ?? {};
  console.log(`MCP: ${mcpUrl}`);
  console.log(`Booked ${booking.serviceName}, ${booking.display}, for ${booking.customer?.displayName}: ${booking.status}.`);
  console.log(`The shop sees the agent as: ${agent.name} (${agent.confirmed ? "confirmed" : "unconfirmed"}).`);
  console.log(`Approve or decline it here: ${booking.approval?.url}`);
  console.log(`Booking id: ${booking.id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`demo-pap-agent: ${err?.message ?? err}`);
    process.exit(1);
  });
}
