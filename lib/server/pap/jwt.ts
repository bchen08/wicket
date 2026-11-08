// Compact JWTs as PAP 0.4 uses them: decode one, check its signature with a public JWK (ES256 or PS384,
// through WebCrypto), and compute a key's RFC 7638 thumbprint. No dependencies.

/** A public JSON Web Key. Only the members PAP's algorithms need are read. */
export type Jwk = {
  kty: string;
  kid?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  [member: string]: unknown;
};

/** The algorithms PAP signs with: ES256 everywhere, PS384 also for delegations (PAP 0.4 section 5.2). */
export type JwsAlgorithm = "ES256" | "PS384";

/** A decoded compact JWT. Nothing about it is checked yet. */
export type DecodedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** `<header>.<payload>` as bytes: what the signature covers. */
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Bytes from base64url (no padding), or null if `text` isn't base64url. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** base64url without padding, of bytes or of a string's UTF-8. */
export function base64urlEncode(data: Uint8Array | string): string {
  return Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");
}

function jsonObject(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A compact JWT's header, payload and signature, or null if it isn't three base64url parts with JSON objects. */
export function decodeJwt(compact: string): DecodedJwt | null {
  const parts = compact.trim().split(".");
  if (parts.length !== 3) return null;
  const header = jsonObject(base64urlDecode(parts[0]));
  const payload = jsonObject(base64urlDecode(parts[1]));
  const signature = base64urlDecode(parts[2]);
  if (!header || !payload || !signature) return null;
  return { header, payload, signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`), signature };
}

/** The WebCrypto import and verify parameters for `alg`, with only the public members of `jwk`. */
function webCrypto(jwk: Jwk, alg: JwsAlgorithm) {
  if (alg === "ES256") {
    return {
      keyData: { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey,
      importParams: { name: "ECDSA", namedCurve: "P-256" } as EcKeyImportParams,
      verifyParams: { name: "ECDSA", hash: "SHA-256" } as EcdsaParams,
      ok: jwk.kty === "EC" && jwk.crv === "P-256",
    };
  }
  return {
    keyData: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey,
    importParams: { name: "RSA-PSS", hash: "SHA-384" } as RsaHashedImportParams,
    // PS384's salt is as long as its hash (RFC 7518 section 3.5).
    verifyParams: { name: "RSA-PSS", saltLength: 48 } as RsaPssParams,
    ok: jwk.kty === "RSA",
  };
}

/** Whether `jwt` is signed with `alg` by the private half of `jwk`. A key of the wrong type, or a malformed one, is false. */
export async function verifySignature(jwt: DecodedJwt, jwk: Jwk, alg: JwsAlgorithm): Promise<boolean> {
  const params = webCrypto(jwk, alg);
  if (!params.ok) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", params.keyData, params.importParams, false, ["verify"]);
    return await crypto.subtle.verify(params.verifyParams, key, jwt.signature, jwt.signingInput);
  } catch {
    return false;
  }
}

/** A key's JWK thumbprint (RFC 7638, SHA-256, base64url): the `kid` of a Session JWT names its delegated key this way. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  // The required members only, in lexicographic order, with no whitespace.
  const canonical =
    jwk.kty === "EC"
      ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
      : JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64urlEncode(new Uint8Array(digest));
}
