import { DateTime, Info } from "luxon";

// RFC 3339 date-time with a mandatory offset ("Z" or ±HH:MM), e.g. "2026-11-14T09:00:00-05:00".
// Every field is range-checked here (hour 00–23, minute/second 00–59, offset up to ±23:59) because
// Luxon would otherwise accept e.g. "+99:99" or "T24:00" and silently move the instant to
// another day. Calendar validity (Feb 30) is checked by Luxon below.
// Seconds are optional because agents often omit them. Leap seconds (":60") and a space
// instead of "T" are rejected.
const RFC3339 =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

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
