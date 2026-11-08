import type { Booking, NightlyCounts, NightlyRun, NightlyRunResponse } from "../../types/frontdesk";
import { syncDeposit } from "../deposits/deposits";
import { ALL_TIME } from "./booking-store";
import { getFrontDeskDeps } from "./deps";
import { FrontDeskError } from "./errors";
import { respond } from "./http";
import { transitionBooking, withRequestOrigin, type FrontDeskDeps } from "./service";

// The nightly tidy-up: GET /api/jobs/nightly, which Vercel Cron calls once a day at 08:00 UTC (03:00 in New
// York; vercel.json). See docs/nightly.md. For every shop, in this order:
//
//   a) Expire what lapsed, so no hold or unpaid deposit stays open past its deadline even if nobody reads it:
//      - holds awaiting approval past approve_by: store.expireStaleHolds, the statement book's lazy expiry runs;
//      - bookings awaiting their deposit past pay_by: syncDeposit, the code every read runs. Stripe says it
//        wasn't paid → expired, its Checkout page closed (a hold placed at the last moment is cancelled);
//        Stripe says it was paid after all → confirmed (the owner is alerted), as on any read.
//   b) Complete every confirmed booking that ended more than COMPLETE_AFTER_HOURS ago, actor system:
//      transitionBooking, the owner's complete path, which releases the deposit hold in Stripe.
//
// Then one row in nightly_runs (store.recordNightlyRun), which GET /api/status shows as lastNightlyRun.
//
// Safe to run twice, or at the same time as anything else: each step picks only bookings still in the status
// it changes, and every change is conditional on that status (store.transition), so a second run finds nothing
// left to do. A Stripe failure never stops the run: moveDeposit records it on the booking as a
// deposit.action_failed event, the booking keeps its new status, and the run counts it in `failures` and
// goes on. Retrying a refused release: TODO(ring-2), as for the owner's actions.

/** A confirmed booking is completed once it ended this long ago, so the owner has the evening to mark it themselves. */
export const COMPLETE_AFTER_HOURS = 3;

const HOUR_MS = 60 * 60 * 1000;

/** Deposit states a release moves money from: the hold on the card, or the open payment page. */
const RELEASABLE: ReadonlySet<Booking["deposit"]["state"]> = new Set(["held", "awaiting_payment"]);

function noCounts(): NightlyCounts {
  return { expired: 0, completed: 0, depositsReleased: 0, failures: 0 };
}

function addCounts(into: NightlyCounts, more: NightlyCounts): void {
  into.expired += more.expired;
  into.completed += more.completed;
  into.depositsReleased += more.depositsReleased;
  into.failures += more.failures;
}

/** One JSON line in the function log, like the deposit and alert logs. */
function logNightly(event: string, fields: Record<string, unknown>, err?: unknown): void {
  const line = JSON.stringify({ event, ...fields, ...(err === undefined ? {} : { error: err instanceof Error ? err.message : String(err) }) });
  if (err === undefined) console.log(line);
  else console.error(line);
}

/**
 * Count what a change did to `before`'s deposit: released (the hold dropped, or the payment page closed) or,
 * when there was money to release and it's still there, a failure (moveDeposit recorded deposit.action_failed).
 */
function countDeposit(counts: NightlyCounts, before: Booking, after: Booking): void {
  if (!RELEASABLE.has(before.deposit.state)) return;
  if (after.deposit.state === "released") {
    counts.depositsReleased++;
  } else {
    counts.failures++;
    logNightly("nightly.release_failed", { id: after.id, shop: after.shopSlug, message: after.deposit.actionFailed?.message ?? null });
  }
}

/**
 * The tidy-up for one shop (steps a and b above), with the counts. A booking that can't be finished is
 * counted in `failures`, logged, and left for the next run; the others still run. Throws only if the shop's
 * bookings can't be read or expired at all.
 */
export async function tidyShop(deps: FrontDeskDeps, shopSlug: string): Promise<NightlyCounts> {
  const counts = noCounts();
  const now = deps.clock.now();

  // a) Holds awaiting approval past approve_by: one statement, one "expired" event each.
  counts.expired += await deps.store.expireStaleHolds(shopSlug, ALL_TIME, now);

  // a) Bookings awaiting their deposit past pay_by: ask Stripe, then expire (or confirm) each.
  const waiting = await deps.store.listBookings(shopSlug, ALL_TIME, ["awaiting_deposit"]);
  for (const booking of waiting.filter((b) => b.deposit.payBy !== undefined && Date.parse(b.deposit.payBy) <= now.getTime())) {
    try {
      const after = await syncDeposit(deps, booking);
      if (after.status === "expired") {
        counts.expired++;
        countDeposit(counts, booking, after);
      } else if (after.status === "awaiting_deposit") {
        // Stripe didn't say whether it was paid (syncDeposit logged deposit.sync_failed), so the time stays
        // held for now: the next read, or the next run, asks again.
        counts.failures++;
        logNightly("nightly.deposit_unknown", { id: booking.id, shop: shopSlug });
      }
      // confirmed: the person paid at the last moment; syncDeposit confirmed it and alerted the owner.
    } catch (err) {
      counts.failures++;
      logNightly("nightly.expire_failed", { id: booking.id, shop: shopSlug }, err);
    }
  }

  // b) Confirmed bookings that ended more than COMPLETE_AFTER_HOURS ago → completed, deposit released.
  const endedBy = new Date(now.getTime() - COMPLETE_AFTER_HOURS * HOUR_MS);
  const confirmed = await deps.store.listBookings(shopSlug, { start: ALL_TIME.start, end: endedBy }, ["confirmed"]);
  for (const booking of confirmed.filter((b) => Date.parse(b.end) < endedBy.getTime())) {
    try {
      const result = await transitionBooking(deps, shopSlug, booking.id, "complete", "system");
      counts.completed++;
      countDeposit(counts, booking, result.booking);
    } catch (err) {
      // The owner (or another run) changed it since the list was read, e.g. marked it a no-show: decide()
      // refuses to complete it now, and there's nothing left to do.
      if (err instanceof FrontDeskError) continue;
      counts.failures++;
      logNightly("nightly.complete_failed", { id: booking.id, shop: shopSlug }, err);
    }
  }

  return counts;
}

/**
 * Run the tidy-up for every shop and record it (store.recordNightlyRun). A shop that can't be tidied at all
 * counts as one failure and the next shop still runs. Throws only if the shops can't be listed or the run
 * can't be recorded (the database is down).
 */
export async function runNightly(deps: FrontDeskDeps): Promise<NightlyRun> {
  const total = noCounts();
  for (const shop of await deps.catalog.listShops()) {
    try {
      addCounts(total, await tidyShop(deps, shop.slug));
    } catch (err) {
      total.failures++;
      logNightly("nightly.shop_failed", { shop: shop.slug }, err);
    }
  }
  const run = await deps.store.recordNightlyRun(total);
  logNightly("nightly.ran", run);
  return run;
}

/**
 * GET /api/jobs/nightly → 200 NightlyRunResponse, or the ApiError envelope (500 internal) if the database
 * can't be reached. Public, like /api/status: no secret (see docs/nightly.md). `getDeps` is called inside, so
 * configuration errors become the envelope too.
 */
export function nightlyGet(request: Request, getDeps: () => FrontDeskDeps = getFrontDeskDeps): Promise<Response> {
  return respond<NightlyRunResponse>(() => runNightly(withRequestOrigin(getDeps(), request)));
}
