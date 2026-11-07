import { DateTime } from "luxon";
import type { Slot } from "../../types/frontdesk";
import type { BusyInterval, StaffHours } from "../frontdesk/catalog";
import { FrontDeskError } from "../frontdesk/errors";
import { isValidZone, toRfc3339 } from "../frontdesk/time";

// Pure availability engine: no I/O, no clock reads. The same input always gives the same output.
//
// TODO(ring-1): minimum lead time (e.g. no bookings within 2 hours).
// TODO(ring-1): booking horizon (how far ahead a shop takes bookings).
// TODO(ring-1): deposit horizon (when a deposit is required based on how far ahead).
// TODO(ring-1): daylight-saving gap/overlap handling. Today, a local time that doesn't exist
//               is shifted forward by Luxon and a repeated hour uses the first occurrence.

/** Starts are offered on this grid, in minutes from opening time. */
export const SLOT_STEP_MIN = 15;
/** Longest window an agent may ask about in one call. */
export const MAX_WINDOW_DAYS = 14;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AvailabilityInput = {
  /** IANA zone the shop's hours are written in. */
  timezone: string;
  /** Length of the service in minutes. */
  durationMin: number;
  staffHours: StaffHours[];
  /** Busy intervals, half-open [start, end). Only those for a matching staffId apply. */
  busy: BusyInterval[];
  /** Window start (inclusive): slots start at or after this. */
  from: Date;
  /** Window end (exclusive): slots start before this. */
  to: Date;
  /** Current time. Starts before `now` are never offered. */
  now: Date;
  /** Maximum slots to return, 1–50. Defaults to 20. */
  limit?: number;
};

export type AvailabilityResult = {
  slots: Slot[];
  truncated: boolean;
};

type Candidate = { start: DateTime; end: DateTime; staffId: string };

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`Invalid "HH:mm" time in staff hours: "${hhmm}"`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** "Sat 14 Nov, 2:30 pm EST" in the shop's zone. */
export function formatDisplay(start: DateTime): string {
  const local = start.setLocale("en-US");
  const meridiem = local.hour < 12 ? "am" : "pm";
  return `${local.toFormat("ccc d LLL, h:mm")} ${meridiem} ${local.toFormat("ZZZZ")}`;
}

/**
 * Check the caller-controlled parts of a request: the window and the limit.
 * Returns the effective limit. Throws FrontDeskError("invalid_request").
 */
export function validateRequest(req: { from: Date; to: Date; limit?: number }): number {
  const { from, to } = req;
  const limit = req.limit ?? DEFAULT_LIMIT;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new FrontDeskError(
      "invalid_request",
      "from and to must be valid instants.",
      "Send from and to as RFC 3339 date-times with an offset, e.g. 2026-11-14T00:00:00-05:00.",
    );
  }
  if (from.getTime() >= to.getTime()) {
    throw new FrontDeskError(
      "invalid_request",
      "from must be earlier than to.",
      "Send a window where from is before to, e.g. from = the start of a day and to = the start of the next day.",
      { from: from.toISOString(), to: to.toISOString() },
    );
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new FrontDeskError(
      "invalid_request",
      `The window is longer than ${MAX_WINDOW_DAYS} days.`,
      `Ask for at most ${MAX_WINDOW_DAYS} days at a time; split longer ranges into several calls.`,
      { maxWindowDays: MAX_WINDOW_DAYS, from: from.toISOString(), to: to.toISOString() },
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new FrontDeskError(
      "invalid_request",
      `limit must be a whole number from 1 to ${MAX_LIMIT}.`,
      `Omit limit to get up to ${DEFAULT_LIMIT} slots, or pass a whole number from 1 to ${MAX_LIMIT}.`,
      { limit, maxLimit: MAX_LIMIT },
    );
  }
  return limit;
}

function validate(input: AvailabilityInput): number {
  const limit = validateRequest(input);
  // The checks below are about our own data, not the caller's request.
  const { durationMin, timezone } = input;
  if (!Number.isInteger(durationMin) || durationMin <= 0) {
    throw new Error(`Service duration must be a positive whole number of minutes, got ${durationMin}`);
  }
  if (!isValidZone(timezone)) {
    throw new Error(`Shop time zone is not a valid IANA zone: "${timezone}"`);
  }
  return limit;
}

/**
 * Every start time in [from, to) at which a staff member is free for `durationMin` minutes.
 *
 * - Each staff member's weekly hours are expanded into instants in `timezone` for every local
 *   date the window touches.
 * - Starts are generated every 15 minutes from opening while start + duration <= closing.
 * - Starts before `now`, and starts whose [start, start + duration) overlaps one of that staff
 *   member's busy intervals, are dropped. Intervals are half-open, so back-to-back is allowed.
 * - Sorted by start (then staffId), capped at `limit`; `truncated` says whether more exist.
 *
 * Throws FrontDeskError("invalid_request") for a bad window or limit.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const limit = validate(input);
  const { timezone, durationMin, staffHours, busy, from, to, now } = input;

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const earliestMs = Math.max(fromMs, now.getTime());

  const busyByStaff = new Map<string, { start: number; end: number }[]>();
  for (const b of busy) {
    const list = busyByStaff.get(b.staffId) ?? [];
    list.push({ start: b.start.getTime(), end: b.end.getTime() });
    busyByStaff.set(b.staffId, list);
  }

  const firstDay = DateTime.fromJSDate(from, { zone: timezone }).startOf("day");
  const candidates: Candidate[] = [];
  const seen = new Set<string>(); // overlapping weekly windows must not produce duplicate slots

  for (let day = firstDay; day.toMillis() < toMs; day = day.plus({ days: 1 })) {
    for (const staff of staffHours) {
      const staffBusy = busyByStaff.get(staff.staffId) ?? [];
      for (const hours of staff.weekly) {
        if (hours.weekday !== day.weekday) continue;
        const open = day.set({ ...parseHhmm(hours.open), second: 0, millisecond: 0 });
        const close = day.set({ ...parseHhmm(hours.close), second: 0, millisecond: 0 });

        for (
          let start = open;
          start.plus({ minutes: durationMin }) <= close;
          start = start.plus({ minutes: SLOT_STEP_MIN })
        ) {
          const startMs = start.toMillis();
          if (startMs < earliestMs || startMs >= toMs) continue;
          const end = start.plus({ minutes: durationMin });
          const endMs = end.toMillis();
          const clashes = staffBusy.some((b) => b.start < endMs && startMs < b.end);
          if (clashes) continue;
          const key = `${staff.staffId}|${startMs}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ start, end, staffId: staff.staffId });
        }
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.start.toMillis() - b.start.toMillis() ||
      (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0),
  );

  const slots: Slot[] = candidates.slice(0, limit).map((c) => ({
    start: toRfc3339(c.start.toJSDate(), timezone),
    end: toRfc3339(c.end.toJSDate(), timezone),
    staffId: c.staffId,
    display: formatDisplay(c.start),
  }));

  return { slots, truncated: candidates.length > limit };
}
