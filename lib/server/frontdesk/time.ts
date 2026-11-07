import { DateTime, Info } from "luxon";

// RFC 3339 date-time with a mandatory offset ("Z" or ±HH:MM), e.g. "2026-11-14T09:00:00-05:00".
// Seconds are optional because agents often omit them; a space instead of "T" is rejected.
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Parse an RFC 3339 instant that carries an explicit offset. Returns null if it isn't one. */
export function parseRfc3339(value: string): Date | null {
  if (!RFC3339.test(value)) return null;
  const dt = DateTime.fromISO(value, { setZone: true });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Format an instant as RFC 3339 in `zone`, without milliseconds, e.g. "2026-11-14T09:00:00-05:00". */
export function toRfc3339(instant: Date, zone: string): string {
  const iso = DateTime.fromJSDate(instant, { zone }).toISO({ suppressMilliseconds: true });
  if (!iso) throw new Error(`Cannot format ${instant.toString()} in zone ${zone}`);
  return iso;
}

/** True if `zone` is an IANA zone name, e.g. "America/New_York". */
export function isValidZone(zone: string): boolean {
  return Info.isValidIANAZone(zone);
}
