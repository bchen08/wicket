import { DateTime, IANAZone } from "luxon";
import type { Slot } from "../../types/frontdesk";
import type { BusyInterval, StaffHours } from "../frontdesk/catalog";
import { FrontDeskError } from "../frontdesk/errors";
import { isValidZone, toRfc3339 } from "../frontdesk/time";

// Pure availability engine: no I/O, no clock reads. The same input always gives the same output.
//
// The rules, shared by computeAvailability, checkStart and nearbySlots:
// - Hours: each staff member's weekly "HH:mm" windows become instants in the shop's zone
//   (resolveLocalTime). Starts run every 15 minutes of elapsed time from opening while
//   start + duration <= closing, and may not overlap that staff member's busy intervals
//   (bookings and blocked time alike; intervals are half-open, so back-to-back is fine).
// - Lead time: nothing starts before now + rules.leadTimeMin, rounded up to the shop's local
//   15-minute grid (ceilToGrid).
// - Horizon: starts are strictly before now + rules.horizonDays calendar days in the shop's zone,
//   or now + rules.depositHorizonDays when the service takes a deposit.
// - Pause: rules.paused offers nothing.
// - Daylight saving: a local time in the spring gap moves forward to the instant the gap ends; a
//   repeated local time in the autumn overlap means its first occurrence. Because starts step in
//   elapsed time, the missing hour has no starts and the repeated hour's starts appear twice, once
//   per offset ("1:00 am EDT", then "1:00 am EST").
// Without `rules` (Ring 0 callers) there is no lead time, no horizon and no pause: only starts
// before `now` are dropped.

/** Starts are offered on this grid, in minutes from opening time. */
export const SLOT_STEP_MIN = 15;
/** Longest window an agent may ask about in one call. */
export const MAX_WINDOW_DAYS = 14;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const STEP_MS = SLOT_STEP_MIN * MIN_MS;

/** The shop policies the engine applies. Every Policies (lib/types/frontdesk.ts) is one. */
export type BookingRules = {
  /** Minimum minutes between now and a start. */
  leadTimeMin: number;
  /** How many days ahead a service without a deposit can be booked. */
  horizonDays: number;
  /** How many days ahead a service with a deposit can be booked. */
  depositHorizonDays: number;
  /** true: nothing is bookable. */
  paused: boolean;
};

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
  /** Current time. Starts before `now` (before now + lead time, with `rules`) are never offered. */
  now: Date;
  /** Maximum slots to return, 1–50. Defaults to 20. */
  limit?: number;
  /** The service's deposit in cents. > 0 selects rules.depositHorizonDays. Defaults to 0. */
  depositCents?: number;
  /** The shop's booking rules. Omitted: no lead time, no horizon, never paused (Ring 0 behaviour). */
  rules?: BookingRules;
};

export type AvailabilityResult = {
  slots: Slot[];
  truncated: boolean;
};

/** What checkStart and nearbySlots need: an availability request without the window and limit. */
export type StartCheckInput = Omit<AvailabilityInput, "from" | "to" | "limit">;

/** Whether one requested start is bookable, and if not, the most specific reason. */
export type StartCheck =
  | { ok: true; slot: Slot }
  | { ok: false; reason: "paused" }
  | { ok: false; reason: "too_soon"; earliest: Date }
  | { ok: false; reason: "too_far"; latest: Date }
  | { ok: false; reason: "outside_hours" }
  | { ok: false; reason: "taken" };

/** A free start for one staff member, as epoch milliseconds. */
type Candidate = { startMs: number; endMs: number; staffId: string };

/** The parts of a request that describe the shop and the service (not the window). */
type ShopData = Pick<AvailabilityInput, "timezone" | "durationMin" | "staffHours">;

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`Invalid "HH:mm" time in staff hours: "${hhmm}"`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The Luxon zone for an IANA name. Throws for an unknown zone (our data, not the caller's). */
function ianaZone(name: string): IANAZone {
  const zone = IANAZone.create(name);
  if (!zone.isValid) throw new Error(`Shop time zone is not a valid IANA zone: "${name}"`);
  return zone;
}

/** "Sat 14 Nov, 2:30 pm EST" in the shop's zone. */
export function formatDisplay(start: DateTime): string {
  const local = start.setLocale("en-US");
  const meridiem = local.hour < 12 ? "am" : "pm";
  return `${local.toFormat("ccc d LLL, h:mm")} ${meridiem} ${local.toFormat("ZZZZ")}`;
}

/**
 * Round `instant` up to the next local multiple of `stepMin` minutes in `timezone`
 * (:00/:15/:30/:45 for the default 15). An instant already on the grid, with zero seconds and
 * milliseconds, is returned unchanged. Rounding adds elapsed time, so 1:50 am EST on the
 * spring-forward day becomes 3:00 am EDT.
 */
export function ceilToGrid(instant: Date, timezone: string, stepMin: number = SLOT_STEP_MIN): Date {
  if (!Number.isInteger(stepMin) || stepMin <= 0) {
    throw new Error(`Grid step must be a positive whole number of minutes, got ${stepMin}`);
  }
  const ms = instant.getTime();
  const stepMs = stepMin * MIN_MS;
  const localMs = ms + ianaZone(timezone).offset(ms) * MIN_MS; // the wall clock, read as if UTC
  const past = ((localMs % stepMs) + stepMs) % stepMs;
  return new Date(past === 0 ? ms : ms + stepMs - past);
}

/** resolveLocalTime as epoch milliseconds, for a zone already known to be valid. */
function resolveLocalMs(
  zone: IANAZone,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): number {
  // The wall time read as if it were UTC. The real instant is naive - offset, for whichever offset
  // the zone actually uses at that instant.
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Every offset in use around that date (a transition is never closer than a day to another).
  const offsets = new Set([naive - DAY_MS, naive, naive + DAY_MS].map((t) => zone.offset(t)));
  const candidates = [...offsets].map((offset) => ({ ms: naive - offset * MIN_MS, offset }));
  candidates.sort((a, b) => a.ms - b.ms);

  // An instant whose own offset gives back the wall time is a real occurrence of it. In the autumn
  // overlap there are two; the earliest is the first occurrence.
  const real = candidates.find((c) => zone.offset(c.ms) === c.offset);
  if (real) return real.ms;

  // None: the wall time falls in the spring gap. The candidates straddle the transition, so
  // binary-search for the first millisecond on the new offset: the instant the gap ends.
  let lo = candidates[0].ms; // on the old offset
  let hi = candidates[candidates.length - 1].ms; // on the new offset
  const before = zone.offset(lo);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zone.offset(mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The instant at which the wall clock in `zone` reads `hour`:`minute` on the local `date`
 * (month 1–12). Daylight saving is resolved the way a shop expects, which is not Luxon's default:
 * - a time that doesn't exist (the spring gap) moves forward to the instant the gap ends, e.g.
 *   2026-03-08 02:30 America/New_York → 03:00 EDT;
 * - a repeated time (the autumn overlap) means its first occurrence, e.g.
 *   2026-11-01 01:30 America/New_York → 01:30 EDT (05:30Z).
 * Returns a DateTime in `zone`. Throws for an unknown zone.
 */
export function resolveLocalTime(
  zone: string,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): DateTime {
  return DateTime.fromMillis(resolveLocalMs(ianaZone(zone), date, hour, minute), { zone });
}

/**
 * The range of starts the shop's rules allow at `now`, before hours and busy time are considered.
 * - earliest (inclusive): now + rules.leadTimeMin rounded up with ceilToGrid; `now` without rules.
 * - latest (exclusive): now + rules.depositHorizonDays calendar days in `timezone` if
 *   depositCents > 0, else now + rules.horizonDays (same local time across a DST change);
 *   null (no horizon) without rules.
 */
export function bookingBounds(args: {
  now: Date;
  timezone: string;
  depositCents?: number;
  rules?: BookingRules;
}): { earliest: Date; latest: Date | null } {
  const { now, timezone, depositCents = 0, rules } = args;
  if (!rules) return { earliest: new Date(now.getTime()), latest: null };

  const earliest = ceilToGrid(new Date(now.getTime() + rules.leadTimeMin * MIN_MS), timezone);
  const days = depositCents > 0 ? rules.depositHorizonDays : rules.horizonDays;
  const latest = DateTime.fromJSDate(now, { zone: timezone }).plus({ days }).toJSDate();
  return { earliest, latest };
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
      `The window is longer than ${MAX_WINDOW_DAYS} days (${MAX_WINDOW_DAYS * 24} hours).`,
      `Ask for at most ${MAX_WINDOW_DAYS * 24} hours at a time (to - from); split longer ranges into several calls.`,
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

/** Check our own data (the shop, the service, the rules). A failure is our bug, so it's a plain Error. */
function validateShopData(input: StartCheckInput): void {
  const { durationMin, timezone, depositCents = 0, rules, now } = input;
  if (!Number.isInteger(durationMin) || durationMin <= 0) {
    throw new Error(`Service duration must be a positive whole number of minutes, got ${durationMin}`);
  }
  if (!isValidZone(timezone)) {
    throw new Error(`Shop time zone is not a valid IANA zone: "${timezone}"`);
  }
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid instant");
  if (!Number.isInteger(depositCents) || depositCents < 0) {
    throw new Error(`Deposit must be a whole number of cents >= 0, got ${depositCents}`);
  }
  if (rules) {
    for (const key of ["leadTimeMin", "horizonDays", "depositHorizonDays"] as const) {
      if (!Number.isInteger(rules[key]) || rules[key] < 0) {
        throw new Error(`Booking rule ${key} must be a whole number >= 0, got ${rules[key]}`);
      }
    }
  }
}

function validate(input: AvailabilityInput): number {
  const limit = validateRequest(input);
  // The checks below are about our own data, not the caller's request.
  validateShopData(input);
  return limit;
}

/** By start, then staffId. */
function byStart(a: Candidate, b: Candidate): number {
  return a.startMs - b.startMs || (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0);
}

/**
 * Every start in [fromMs, toMs) at which a staff member is free for the service, given `busy`.
 * Unlimited; sorted by start, then staffId. Knows nothing about lead time, horizons or pause:
 * callers fold those into the range.
 */
function freeStarts(shop: ShopData, busy: BusyInterval[], fromMs: number, toMs: number): Candidate[] {
  if (!(fromMs < toMs)) return [];
  const zone = ianaZone(shop.timezone);
  const durationMs = shop.durationMin * MIN_MS;

  const busyByStaff = new Map<string, { start: number; end: number }[]>();
  for (const b of busy) {
    const list = busyByStaff.get(b.staffId) ?? [];
    list.push({ start: b.start.getTime(), end: b.end.getTime() });
    busyByStaff.set(b.staffId, list);
  }

  // Walk local calendar dates (in UTC, so the walk itself never meets a DST change), from the day
  // before the range's first local date, in case a time in a gap was moved across midnight.
  const first = DateTime.fromMillis(fromMs, { zone: shop.timezone });
  const last = DateTime.fromMillis(toMs - 1, { zone: shop.timezone });
  const lastDate = DateTime.utc(last.year, last.month, last.day);

  const candidates: Candidate[] = [];
  const seen = new Set<string>(); // overlapping weekly windows must not produce duplicate slots

  for (
    let date = DateTime.utc(first.year, first.month, first.day).minus({ days: 1 });
    date <= lastDate;
    date = date.plus({ days: 1 })
  ) {
    for (const staff of shop.staffHours) {
      const staffBusy = busyByStaff.get(staff.staffId) ?? [];
      for (const hours of staff.weekly) {
        if (hours.weekday !== date.weekday) continue;
        const open = parseHhmm(hours.open);
        const close = parseHhmm(hours.close);
        const openMs = resolveLocalMs(zone, date, open.hour, open.minute);
        const closeMs = resolveLocalMs(zone, date, close.hour, close.minute);

        // Elapsed time, so a DST change inside the hours shifts the local times, not the spacing.
        for (let startMs = openMs; startMs + durationMs <= closeMs; startMs += STEP_MS) {
          if (startMs >= toMs) break;
          if (startMs < fromMs) continue;
          const endMs = startMs + durationMs;
          if (staffBusy.some((b) => b.start < endMs && startMs < b.end)) continue;
          const key = `${staff.staffId}|${startMs}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ startMs, endMs, staffId: staff.staffId });
        }
      }
    }
  }

  return candidates.sort(byStart);
}

function toSlot(c: Candidate, timezone: string): Slot {
  return {
    start: toRfc3339(new Date(c.startMs), timezone),
    end: toRfc3339(new Date(c.endMs), timezone),
    staffId: c.staffId,
    display: formatDisplay(DateTime.fromMillis(c.startMs, { zone: timezone })),
  };
}

/** The range of starts both the window and the rules allow, as [fromMs, toMs). */
function allowedRange(input: StartCheckInput, fromMs: number, toMs: number): [number, number] {
  const { earliest, latest } = bookingBounds(input);
  return [Math.max(fromMs, earliest.getTime()), Math.min(toMs, latest?.getTime() ?? Infinity)];
}

/**
 * Every start time in [from, to) at which a staff member is free for `durationMin` minutes and
 * the shop's rules allow it.
 *
 * - Each staff member's weekly hours are expanded into instants in `timezone` for every local
 *   date the window touches, with daylight saving resolved by resolveLocalTime.
 * - Starts are generated every 15 minutes from opening while start + duration <= closing.
 * - Starts before bookingBounds().earliest (now, or now + lead time on the grid), at or after
 *   bookingBounds().latest (the horizon), and starts whose [start, start + duration) overlaps one
 *   of that staff member's busy intervals, are dropped. Intervals are half-open, so back-to-back
 *   is allowed.
 * - A paused shop gets no slots (after the request is validated).
 * - Sorted by start (then staffId), capped at `limit`; `truncated` says whether more exist.
 *
 * Throws FrontDeskError("invalid_request") for a bad window or limit.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const limit = validate(input);
  if (input.rules?.paused) return { slots: [], truncated: false };

  const [fromMs, toMs] = allowedRange(input, input.from.getTime(), input.to.getTime());
  const candidates = freeStarts(input, input.busy, fromMs, toMs);
  return {
    slots: candidates.slice(0, limit).map((c) => toSlot(c, input.timezone)),
    truncated: candidates.length > limit,
  };
}

/**
 * Classify one requested start, checking in this order:
 * 1. "paused": the shop has paused bookings.
 * 2. "too_soon": before bookingBounds().earliest, which is returned.
 * 3. "too_far": at or after bookingBounds().latest, which is returned.
 * 4. ok: some staff member is free for the whole service from exactly `start`; the slot is the
 *    first such staff member by staffId.
 * 5. "taken": it would be free if only blocked time (busy intervals of kind "block") counted, so
 *    a booking is in the way.
 * 6. "outside_hours": anything else: off the 15-minute grid, closed, a break, blocked time, or the
 *    service would run past closing.
 */
export function checkStart(input: StartCheckInput, start: Date): StartCheck {
  validateShopData(input);
  const startMs = start.getTime();
  if (Number.isNaN(startMs)) throw new Error("checkStart needs a valid start instant");

  if (input.rules?.paused) return { ok: false, reason: "paused" };
  const { earliest, latest } = bookingBounds(input);
  if (startMs < earliest.getTime()) return { ok: false, reason: "too_soon", earliest };
  if (latest !== null && startMs >= latest.getTime()) return { ok: false, reason: "too_far", latest };

  const free = freeStarts(input, input.busy, startMs, startMs + 1);
  if (free.length > 0) return { ok: true, slot: toSlot(free[0], input.timezone) };

  const blocksOnly = input.busy.filter((b) => b.kind === "block");
  if (freeStarts(input, blocksOnly, startMs, startMs + 1).length > 0) return { ok: false, reason: "taken" };
  return { ok: false, reason: "outside_hours" };
}

/**
 * Up to `count` free slots near `start`, e.g. alternatives for a slot_taken error. Considers slots
 * starting within 24 hours either side of `start` (inclusive) that the rules allow (none when
 * paused), keeps the `count` closest to `start` (on a tie, the earlier), and returns them earliest
 * first. Not capped by MAX_LIMIT.
 */
export function nearbySlots(input: StartCheckInput, start: Date, count = 3): Slot[] {
  validateShopData(input);
  const startMs = start.getTime();
  if (Number.isNaN(startMs)) throw new Error("nearbySlots needs a valid start instant");
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`nearbySlots count must be a whole number >= 0, got ${count}`);
  }
  if (input.rules?.paused) return [];

  const [fromMs, toMs] = allowedRange(input, startMs - DAY_MS, startMs + DAY_MS + 1);
  const distance = (c: Candidate) => Math.abs(c.startMs - startMs);
  return freeStarts(input, input.busy, fromMs, toMs)
    .sort((a, b) => distance(a) - distance(b) || byStart(a, b))
    .slice(0, count)
    .sort(byStart)
    .map((c) => toSlot(c, input.timezone));
}
