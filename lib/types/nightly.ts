// The nightly tidy-up: GET /api/jobs/nightly, which Vercel Cron calls once a day at 08:00 UTC (03:00 in
// New York). Re-exported from lib/types/frontdesk.ts, which is what the UI imports. See docs/nightly.md.

/** What one run of the nightly tidy-up did, over every shop. */
export type NightlyCounts = {
  /**
   * Bookings this run expired: holds awaiting approval past their approve-by time, and bookings awaiting
   * their deposit past their pay-by time that Stripe says weren't paid.
   */
  expired: number;
  /** Confirmed bookings that ended more than 3 hours ago, which this run marked completed (actor `system`). */
  completed: number;
  /**
   * Deposits this run released: the hold on a completed booking's card dropped (its PaymentIntent
   * cancelled), or an expired booking's unpaid Stripe Checkout page closed. Deposits that were never held
   * (none, not_collected) aren't counted.
   */
  depositsReleased: number;
  /**
   * Bookings this run couldn't finish: Stripe refused to release a deposit (recorded on the booking as a
   * `deposit.action_failed` event and `deposit.actionFailed`; the booking still changed), Stripe didn't say
   * whether an awaiting deposit was paid (the booking is left as it is), or an error. Each is logged. The
   * next run tries the ones left as they were again; a refused release isn't retried (TODO(ring-2)).
   */
  failures: number;
};

/** One run of the nightly tidy-up: GET /api/jobs/nightly's answer, and StatusResponse.lastNightlyRun. */
export type NightlyRun = NightlyCounts & {
  /** When the run finished and was recorded, RFC 3339 in UTC, e.g. "2026-11-10T08:00:04.512Z". */
  ranAt: string;
};

/** GET /api/jobs/nightly → 200. */
export type NightlyRunResponse = NightlyRun;
