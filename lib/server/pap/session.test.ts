import { describe, expect, it } from "vitest";
import {
  createIdentity,
  dataUrl,
  delegate,
  generateKeyPair,
  openSession,
  sessionJwt,
  signJwt,
  thumbprint,
} from "../../../scripts/demo-pap-agent.mjs";
import { AGENT_KEYS_TTL_MS, createAgentKeyCache, fetchJson, type FetchJson } from "./client";
import { companyIdentifier, poppyDocument } from "./discovery";
import { PapError, papErrorResponse } from "./errors";
import { jwkThumbprint } from "./jwt";
import { compatibleVersion, verifySession } from "./session";

// verifySession against sessions the demo PAP agent (scripts/demo-pap-agent.mjs) signs: the same code humans
// and smoke run, so these tests prove the two sides agree.

const AUDIENCE = "https://frontdesk.test";
const MCP_URL = `${AUDIENCE}/api/mcp`;
const NOW = Date.parse("2026-11-09T17:00:00Z");

type Identity = Awaited<ReturnType<typeof createIdentity>>;

/** A key cache that reads data: URLs, counting fetches. */
function countingKeys(fetch: FetchJson = fetchJson) {
  let fetches = 0;
  let clock = NOW;
  const keys = createAgentKeyCache({
    fetch: async (url, options) => {
      fetches++;
      return fetch(url, options);
    },
    now: () => clock,
  });
  return {
    keys,
    fetches: () => fetches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Headers for one MCP request in a new session of `identity`. */
async function headersFor(identity: Identity, { audience = AUDIENCE, now = NOW } = {}) {
  const session = await openSession({ identity, audience, now: () => now });
  return new Headers(await session.headers("POST", MCP_URL));
}

async function verify(headers: Headers, keys = countingKeys().keys, now = NOW) {
  return verifySession(headers, { audience: AUDIENCE, keys, now });
}

/** The PapError verifySession throws. */
async function refusal(promise: Promise<unknown>): Promise<PapError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PapError);
    return err as PapError;
  }
  throw new Error("expected verifySession to refuse");
}

describe("verifySession", () => {
  it("accepts a session the demo agent signs: the client_id, its client_name, sid and User ID", async () => {
    const identity = await createIdentity({ name: "Test Agent" });
    const headers = await headersFor(identity);
    const session = await verify(headers);
    expect(session).toEqual({
      clientId: identity.clientId,
      clientName: "Test Agent",
      sid: expect.stringMatching(/^[A-Za-z0-9_-]{22,}$/),
      sub: expect.stringMatching(/^usr_/),
    });
  });

  it("accepts a session signed up to 90 seconds ago (a minute plus clock skew), and 30 seconds ahead", async () => {
    const identity = await createIdentity();
    await expect(verify(await headersFor(identity, { now: NOW - 90_000 }))).resolves.toBeTruthy();
    await expect(verify(await headersFor(identity, { now: NOW + 30_000 }))).resolves.toBeTruthy();
  });

  it("refuses a Session JWT signed too long ago with invalid_session", async () => {
    const identity = await createIdentity();
    const err = await refusal(verify(await headersFor(identity, { now: NOW - 91_000 })));
    expect(err.code).toBe("invalid_session");
    expect(err.message).toMatch(/iat/);
  });

  it("refuses an expired delegation with invalid_session", async () => {
    const identity = await createIdentity();
    const delegation = await delegate(identity, { now: NOW - 2 * 3600_000, lifetimeSeconds: 3600 });
    const jwt = await sessionJwt({ identity, delegation, audience: AUDIENCE, sid: "s".repeat(22), sub: "usr_1", method: "POST", url: MCP_URL, now: NOW });
    const err = await refusal(verify(new Headers({ "poppy-session": jwt, "poppy-version": "0.4" })));
    expect(err).toMatchObject({ code: "invalid_session", message: expect.stringMatching(/expired/) });
  });

  it("refuses a delegation longer than 24 hours", async () => {
    const identity = await createIdentity();
    const delegation = await delegate(identity, { now: NOW, lifetimeSeconds: 25 * 3600 });
    const jwt = await sessionJwt({ identity, delegation, audience: AUDIENCE, sid: "s".repeat(22), sub: "usr_1", method: "POST", url: MCP_URL, now: NOW });
    const err = await refusal(verify(new Headers({ "poppy-session": jwt, "poppy-version": "0.4" })));
    expect(err).toMatchObject({ code: "invalid_session", message: expect.stringMatching(/24 hours/) });
  });

  it("refuses a session for another Company (wrong aud) with invalid_session naming the right one", async () => {
    const identity = await createIdentity();
    const err = await refusal(verify(await headersFor(identity, { audience: "https://other.example" })));
    expect(err.code).toBe("invalid_session");
    expect(err.message).toContain(AUDIENCE);
  });

  it("refuses a missing or incompatible Poppy-Version with version_unsupported", async () => {
    const identity = await createIdentity();
    const headers = await headersFor(identity);
    headers.delete("poppy-version");
    expect((await refusal(verify(headers))).code).toBe("version_unsupported");
    headers.set("poppy-version", "0.3");
    expect((await refusal(verify(headers))).code).toBe("version_unsupported");
    expect(compatibleVersion("0.4")).toBe(true);
    expect(compatibleVersion(" 00.04 ")).toBe(true);
    expect(compatibleVersion("1.4")).toBe(false);
  });

  it("refuses a header that isn't a Session JWT", async () => {
    for (const value of ["nonsense", "a.b.c", "eyJ0eXAiOiJKV1QifQ.e30.c2ln"]) {
      expect((await refusal(verify(new Headers({ "poppy-session": value, "poppy-version": "0.4" })))).code).toBe("invalid_session");
    }
  });

  it("refuses a Session JWT signed straight with a key from jwks_uri (no delegation)", async () => {
    const identity = await createIdentity();
    const jwt = await signJwt(
      { typ: "poppy-session+jwt", alg: "ES256", kid: identity.kid },
      { iss: identity.clientId, aud: AUDIENCE, sid: "s".repeat(22), sub: "usr_1", htm: "POST", htu: MCP_URL, iat: NOW / 1000, jti: "j".repeat(22) },
      identity.identityKey.privateJwk,
    );
    const err = await refusal(verify(new Headers({ "poppy-session": jwt, "poppy-version": "0.4" })));
    expect(err).toMatchObject({ code: "invalid_session", message: expect.stringMatching(/poppy_dlg/) });
  });

  it("refuses a delegation signed by a key that isn't the agent's", async () => {
    const identity = await createIdentity();
    const impostor = { ...identity, identityKey: await generateKeyPair() };
    const err = await refusal(verify(await headersFor(impostor)));
    expect(err).toMatchObject({ code: "invalid_session", message: expect.stringMatching(/delegation's signature/) });
  });

  it("refuses a Session JWT not signed by its delegated key, or whose kid isn't that key's thumbprint", async () => {
    const identity = await createIdentity();
    const delegation = await delegate(identity, { now: NOW });
    const args = { identity, audience: AUDIENCE, sid: "s".repeat(22), sub: "usr_1", method: "POST", url: MCP_URL, now: NOW };
    const otherKey = await generateKeyPair();
    // Signed by another key, though kid and poppy_dlg name the delegated one.
    const forged = await sessionJwt({ ...args, delegation: { ...delegation, key: otherKey } });
    expect((await refusal(verify(new Headers({ "poppy-session": forged, "poppy-version": "0.4" })))).message).toMatch(/cnf\.jwk/);
    const wrongKid = await sessionJwt({ ...args, delegation: { ...delegation, kid: await thumbprint(otherKey.publicJwk) } });
    expect((await refusal(verify(new Headers({ "poppy-session": wrongKid, "poppy-version": "0.4" })))).message).toMatch(/thumbprint/);
  });

  it("caches an agent's metadata and keys for 10 minutes, then fetches them again", async () => {
    const identity = await createIdentity();
    const cache = countingKeys();
    await verify(await headersFor(identity), cache.keys);
    await verify(await headersFor(identity), cache.keys);
    expect(cache.fetches()).toBe(2); // the client metadata and the key set, once
    cache.advance(AGENT_KEYS_TTL_MS - 1);
    await verify(await headersFor(identity), cache.keys);
    expect(cache.fetches()).toBe(2);
    cache.advance(1);
    await verify(await headersFor(identity), cache.keys);
    expect(cache.fetches()).toBe(4);
  });

  it("fetches the key set again at once for a kid it doesn't know (the agent rotated its key)", async () => {
    // One HTTPS client_id whose key changes: the cache holds the old key set.
    const clientId = "https://agent.example/agent.json";
    let current = await createIdentity({ name: "Rotating Agent" });
    const fetch: FetchJson = async (url) => {
      if (url === clientId) return { client_id: clientId, client_name: "Rotating Agent", jwks_uri: "https://agent.example/jwks.json" };
      if (url === "https://agent.example/jwks.json") return { keys: [{ ...current.identityKey.publicJwk, kid: current.kid }] };
      throw new Error(`unexpected fetch ${url}`);
    };
    const cache = countingKeys(fetch);
    await verify(await headersFor({ ...current, clientId }), cache.keys);
    current = await createIdentity({ name: "Rotating Agent" });
    const session = await verify(await headersFor({ ...current, clientId }), cache.keys);
    expect(session.clientId).toBe(clientId);
    expect(cache.fetches()).toBe(4);
  });

  it("an HTTPS client_id's metadata must name that URL as its client_id", async () => {
    const clientId = "https://agent.example/agent.json";
    const identity = await createIdentity();
    const fetch: FetchJson = async (url) =>
      url === clientId ? { client_id: "https://elsewhere.example/agent.json", client_name: "X", jwks_uri: "https://agent.example/jwks.json" } : { keys: [] };
    const err = await refusal(verify(await headersFor({ ...identity, clientId }), countingKeys(fetch).keys));
    expect(err.message).toMatch(/client_id must be https:\/\/agent\.example\/agent\.json/);
  });

  it("refuses an iss that is neither an HTTPS nor a data: URL", async () => {
    const identity = await createIdentity();
    const err = await refusal(verify(await headersFor({ ...identity, clientId: "http://127.0.0.1:9999/agent.json" })));
    expect(err.message).toMatch(/HTTPS/);
  });

  it("refuses client metadata without a client_name, and a data: URL without JSON", async () => {
    const identity = await createIdentity();
    const nameless = dataUrl({ jwks_uri: dataUrl({ keys: [] }) });
    expect((await refusal(verify(await headersFor({ ...identity, clientId: nameless })))).message).toMatch(/client_name/);
    expect((await refusal(verify(await headersFor({ ...identity, clientId: "data:application/json,not-json" })))).message).toMatch(/JSON/);
  });
});

describe("papErrorResponse", () => {
  it("is HTTP 400 with PAP's JSON body", async () => {
    const res = papErrorResponse(new PapError("invalid_session", "The delegation has expired."));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_session", error_description: "The delegation has expired." });
  });
});

describe("discovery", () => {
  it("poppy.json speaks for the shop on the request's host and points at the MCP endpoint", () => {
    expect(poppyDocument("https://Emergent-Git-X.vercel.app", "Hart's Barbers")).toEqual({
      protocol_version: "0.4",
      organization: { name: "Hart's Barbers", domain: "emergent-git-x.vercel.app" },
      apis: [{ type: "mcp", url: "https://emergent-git-x.vercel.app/api/mcp", description: expect.stringContaining("Hart's Barbers") }],
    });
  });

  it("the Company identifier is https:// plus the host, lowercased (with the port, locally)", () => {
    expect(companyIdentifier("https://Emergent.vercel.app/api/mcp?x=1")).toBe("https://emergent.vercel.app");
    expect(companyIdentifier("http://localhost:3100/api/mcp")).toBe("https://localhost:3100");
  });
});

describe("jwkThumbprint", () => {
  it("matches RFC 7638's example", async () => {
    // RFC 7638 section 3.1.
    const jwk = {
      kty: "RSA",
      e: "AQAB",
      n:
        "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    };
    expect(await jwkThumbprint(jwk)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("agrees with the demo agent's thumbprint for EC keys", async () => {
    const { publicJwk } = await generateKeyPair();
    expect(await jwkThumbprint(publicJwk)).toBe(await thumbprint(publicJwk));
  });
});
