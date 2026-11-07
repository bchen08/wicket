import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// The secrets of the consent flow and how they're stored: only ever as hashes.
//   approval token: 32 random bytes, base64url, in the link; stored as SHA-256 hex.
//   phone number:   E.164; stored as HMAC-SHA256(PHONE_HMAC_PEPPER, number) hex, plus its last 4 digits.
//   code:           6 random digits, texted to the phone; stored as SHA-256 hex.
// None of them is ever logged.

/** SHA-256 of `value` (UTF-8), hex. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A new approval token: 32 random bytes, base64url (43 characters, no padding). */
export function newApprovalToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The shape newApprovalToken produces. Anything else is not a token, and isn't looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN.test(token);
}

/** HMAC-SHA256(pepper, phoneE164), hex: how a phone number is stored and compared. */
export function phoneHmac(pepper: string, phoneE164: string): string {
  return createHmac("sha256", pepper).update(phoneE164, "utf8").digest("hex");
}

/** A new 6-digit code, uniformly random (leading zeros kept), from crypto.randomInt. */
export function newCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Two SHA-256 hex digests compared in constant time. False if either isn't 64 hex characters. */
export function sameDigest(aHex: string, bHex: string): boolean {
  const HEX64 = /^[0-9a-f]{64}$/;
  if (!HEX64.test(aHex) || !HEX64.test(bHex)) return false;
  return timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
}

/** Characters people type in phone numbers that E.164 doesn't have. */
const PHONE_SEPARATORS = /[\s\-().]/g;
/** E.164: "+", a country code that doesn't start with 0, 8–15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** The number as E.164 ("+14015550123"), with spaces, dashes, dots and parentheses removed; null if it isn't E.164. */
export function normalizePhone(value: string): string | null {
  const compact = value.replace(PHONE_SEPARATORS, "");
  return E164.test(compact) ? compact : null;
}

/** The last 4 digits of an E.164 number. */
export function last4(phoneE164: string): string {
  return phoneE164.slice(-4);
}
