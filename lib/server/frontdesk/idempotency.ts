import { createHash } from "node:crypto";
import { FrontDeskError } from "./errors";

// Idempotency keys for the write tools (book, cancel). The store remembers each key with a hash of
// the request it came with (BookingStore.idempotent); these helpers validate the key and build the hash.

/** Shortest idempotency_key accepted. */
export const IDEMPOTENCY_KEY_MIN = 8;
/** Longest idempotency_key accepted. Matches the idempotency_keys.key check. */
export const IDEMPOTENCY_KEY_MAX = 128;

/** 8–128 visible ASCII characters: no spaces, no control characters, nothing outside ASCII. */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/;

/**
 * The caller's idempotency_key, checked: 8–128 visible ASCII characters, no spaces. A UUID passes.
 * Anything else (missing, not a string, too short or long, spaces) is invalid_request.
 */
export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new FrontDeskError(
      "invalid_request",
      `idempotency_key is required and must be ${IDEMPOTENCY_KEY_MIN}–${IDEMPOTENCY_KEY_MAX} visible ASCII characters with no spaces.`,
      `Send a fresh UUID as idempotency_key (${IDEMPOTENCY_KEY_MIN}–${IDEMPOTENCY_KEY_MAX} characters, no spaces). Reuse it only to retry this same call.`,
      { field: "idempotency_key", value: value ?? null },
    );
  }
  return value;
}

/**
 * A stable fingerprint of a request: the sha256 hex digest of `parts` as JSON with its keys sorted,
 * so the same arguments always hash the same whatever order they were built in. Callers normalize
 * the values first (e.g. an instant as toISOString(), a trimmed name).
 */
export function requestHash(parts: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(parts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
