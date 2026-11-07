import type { IdempotentTool } from "./booking-store";
import { FrontDeskError } from "./errors";

// Small helpers both BookingStore implementations share, so memory and Postgres behave (and fail) the same way.

/** `key` was already used for `tool` with different arguments (a different request hash) within the TTL. */
export function idempotencyConflict(key: string, tool: IdempotentTool): FrontDeskError {
  return new FrontDeskError(
    "idempotency_conflict",
    "This idempotency_key was already used with different arguments.",
    "Use a new idempotency_key (a fresh UUID) for a different request.",
    { idempotency_key: key, tool },
  );
}

/** Thrown by idempotent() on the store an idempotent action receives: calls don't nest. */
export function nestedIdempotencyError(): Error {
  return new Error("idempotent() can't be nested: call it on the root store, not on the store an action receives.");
}

/** A canonical (hyphenated) UUID, in either case. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id lowercased if it's a canonical UUID, else null. Both stores look booking and block ids up
 * through this, so a malformed id is simply not found (Postgres would otherwise raise 22P02).
 */
export function normalizeUuid(id: string): string | null {
  return UUID.test(id) ? id.toLowerCase() : null;
}
