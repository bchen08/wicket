import { parseRfc3339 } from "./frontdesk/time";

/** The only place Front Desk reads the current time. Everything else receives `now` as an argument. */
export type Clock = {
  now(): Date;
};

/**
 * Real time, unless FRONTDESK_NOW is set to an RFC 3339 instant (e.g. "2026-11-07T12:00:00-05:00"),
 * in which case time is frozen there. Use it for reproducible demos and tests.
 * Read on every call so the variable can be changed without a restart.
 */
export const systemClock: Clock = {
  now() {
    const fixed = process.env.FRONTDESK_NOW;
    if (fixed === undefined || fixed.trim() === "") return new Date();
    const parsed = parseRfc3339(fixed.trim());
    if (!parsed) {
      throw new Error(
        `FRONTDESK_NOW must be an RFC 3339 instant with an offset (e.g. 2026-11-07T12:00:00-05:00), got "${fixed}".`,
      );
    }
    return parsed;
  },
};

/** A clock frozen at `instant`. For tests. */
export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant.getTime()) };
}
