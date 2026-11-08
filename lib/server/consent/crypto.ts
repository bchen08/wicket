import { randomBytes } from "node:crypto";

// The approval link's token and the person's phone number.
//   approval token: 32 random bytes, base64url, in the link and stored as it is (approvals.token).
//   phone number:   optional, given on approve; E.164, stored as it is.

/** A new approval token: 32 random bytes, base64url (43 characters, no padding). */
export function newApprovalToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The shape newApprovalToken produces. Anything else is not a token, and isn't looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN.test(token);
}

/** The approval page's path for `token`, e.g. "/approve/<token>". The service layer puts the request's origin in front. */
export function approvalPath(token: string): string {
  return `/approve/${token}`;
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
