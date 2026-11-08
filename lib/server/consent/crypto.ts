import { createHash, randomBytes } from "node:crypto";

// The approval link's token and the person's phone number.
//   approval token: 32 random bytes, base64url, in the link; stored as SHA-256 hex. Never logged.
//   phone number:   optional, given on approve; E.164, stored as it is (an MVP decision; no hashing).

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
