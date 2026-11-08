// Deposits (Ring 1c): the deposit a booking carries, and whether this deployment collects deposits.
// Re-exported from lib/types/frontdesk.ts, which is what the UI imports. See docs/deposits.md.
// Money is always an integer number of cents. Instants are RFC 3339 strings with an offset.

/**
 * Where a booking's deposit stands.
 * - `none`: no money has been asked for: the service has no deposit, or the person hasn't approved yet
 *   (or the booking ended before they did).
 * - `awaiting_payment`: the person approved and must pay the hold on Stripe Checkout (`payUrl`) by
 *   `payBy`. The booking is `awaiting_deposit`.
 * - `held`: the person paid. The deposit is authorized on their card (not charged) and the booking is
 *   confirmed.
 * - `captured`: the shop kept the deposit (a no-show, or a cancellation inside the cancellation window):
 *   the card was charged.
 * - `released`: the hold was dropped, or the payment page closed unpaid: the person keeps their money.
 * - `not_collected`: the booking was confirmed without collecting its deposit: deposits are off on this
 *   deployment (no STRIPE_SECRET_KEY), or the start was beyond the deposit horizon when it was approved.
 */
export type DepositState = "none" | "awaiting_payment" | "held" | "captured" | "released" | "not_collected";

/** The deposit on a booking: Booking.deposit. */
export type BookingDeposit = {
  /** The deposit in integer cents (the same as Booking.depositCents). 0 = the service has no deposit. */
  amountCents: number;
  state: DepositState;
  /**
   * The Stripe Checkout page where the person pays the hold. Only while `state` is `awaiting_payment`.
   * Agents send the person the approval link instead: its page has a Pay button that opens this.
   */
  payUrl?: string;
  /** When an unpaid booking expires and its time is freed, RFC 3339. Only while `state` is `awaiting_payment`. */
  payBy?: string;
  /**
   * Stripe refused the last capture or release, so the money didn't move (the booking change stands).
   * Also recorded as a `deposit.action_failed` event. Cleared when a later one succeeds. Retry: TODO(ring-2).
   */
  actionFailed?: {
    action: "capture" | "release";
    /** Stripe's error message. */
    message: string;
    /** When it failed, RFC 3339. */
    at: string;
  };
};

/**
 * Whether this deployment collects deposits (GET /api/status → `deposits`).
 * - `stripe_test`: STRIPE_SECRET_KEY is set. Deposits are held through Stripe Checkout (test mode).
 * - `off`: no key. Approving confirms at once and the deposit shows `not_collected`. Not a problem.
 */
export type DepositsMode = "stripe_test" | "off";
