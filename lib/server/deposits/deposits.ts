import type { Booking, DepositEffect, Shop } from "../../types/frontdesk";
import { approvalPath } from "../consent/crypto";
import { decide, depositPayBy } from "../engine/lifecycle";
import type { DepositRecord, NewBookingEvent } from "../frontdesk/booking-store";
import { FrontDeskError } from "../frontdesk/errors";
import { alertOwner, policiesFor, type FrontDeskDeps } from "../frontdesk/service";
import { isAuthorized, type CheckoutState, type DepositPayments } from "./payments";

// Deposits (Ring 1c): the use cases between Front Desk's bookings and Stripe. See docs/deposits.md.
//
//   approve (consent/approvals.ts) → openCheckout: a Stripe Checkout Session that places a hold; the
//     booking waits in awaiting_deposit until pay_by (approve + 30 minutes).
//   any read of an awaiting_deposit booking → syncDeposit: asks Stripe. Paid → confirmed (deposit held),
//     and the owner is alerted. Unpaid past pay_by → expired, and the payment page is closed.
//   every transition with a deposit effect → moveDeposit, after the database commit: captured → capture
//     the hold, released → release it. A Stripe failure never undoes the booking change: it's recorded
//     as a deposit.action_failed event and on booking.deposit.actionFailed. Retry: TODO(ring-2).
//
// No webhook: reads ask Stripe instead (TODO(ring-2): a webhook, so a booking confirms without a read).

/** A thrown value as one line, for an event or a log. Stripe's errors carry a readable message. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // NUL can't be stored in Postgres text or jsonb; keep it short enough for the owner's list.
  return message.replaceAll("\u0000", "").slice(0, 500);
}

function logDeposit(event: string, booking: Pick<Booking, "id" | "shopSlug">, err: unknown): void {
  console.error(JSON.stringify({ event, id: booking.id, shop: booking.shopSlug, error: errorMessage(err) }));
}

/** The payment page for a booking the person just approved, and when the booking stops waiting for it. */
export type OpenCheckout = { id: string; url: string; payBy: Date };

/**
 * Open the Stripe Checkout page for `booking`'s deposit: a hold of booking.depositCents, returning to the
 * approval page (`token`) whether the person pays or not. The booking waits until now + 30 minutes.
 * Throws whatever Stripe throws: approve then fails (internal) and the person can try again.
 */
export async function openCheckout(
  deps: FrontDeskDeps & { payments: DepositPayments },
  input: { booking: Booking; shop: Shop; token: string; now: Date },
): Promise<OpenCheckout> {
  const { booking, shop, token, now } = input;
  const session = await deps.payments.createCheckout({
    bookingId: booking.id,
    amountCents: booking.depositCents,
    description: `Deposit: ${booking.serviceName} at ${shop.name}, ${booking.display}`,
    returnUrl: `${deps.baseUrl}${approvalPath(token)}`,
  });
  return { ...session, payBy: depositPayBy(now) };
}

/** Close a payment page nobody will use (approve lost a race after opening it). Best effort: failures are logged. */
export async function closeCheckout(deps: FrontDeskDeps, booking: Booking, checkoutId: string): Promise<void> {
  if (!deps.payments) return;
  try {
    await deps.payments.expireCheckout(checkoutId);
  } catch (err) {
    logDeposit("deposit.close_failed", booking, err);
  }
}

/**
 * The booking after asking Stripe about its deposit, if it is awaiting one (any other booking is returned
 * as it is). Called by every read of a booking: get_booking, the approval page, the owner's list and
 * booking routes, and book (for a lapsed one in its way).
 * - Paid (the hold is on the card) → confirmed, deposit held, one deposit.paid event; the owner is alerted.
 *   Even after pay_by: Stripe took the hold, so the time is theirs.
 * - Not paid, and pay_by has passed → expired (one expired event, actor system), then the payment page is
 *   closed (moveDeposit's release). The time is free again.
 * - Otherwise, or if Stripe doesn't answer, unchanged: the next read asks again.
 */
export async function syncDeposit(deps: FrontDeskDeps, booking: Booking): Promise<Booking> {
  if (booking.status !== "awaiting_deposit") return booking;
  const record = await deps.store.getDeposit(booking.id);
  if (!record) return booking;
  if (deps.payments && record.checkoutSessionId) {
    let checkout: CheckoutState;
    try {
      checkout = await deps.payments.getCheckout(record.checkoutSessionId);
    } catch (err) {
      // Can't tell whether it's paid, so keep holding the time; the next read asks again.
      logDeposit("deposit.sync_failed", booking, err);
      return booking;
    }
    if (isAuthorized(checkout)) return confirmPaid(deps, booking, checkout);
  }
  const now = deps.clock.now();
  if (!record.payBy || now.getTime() < record.payBy.getTime()) return booking;
  return expireUnpaid(deps, booking, record);
}

/** The awaiting_deposit booking was paid: confirm it (deposit held) and alert the owner. */
async function confirmPaid(deps: FrontDeskDeps, booking: Booking, checkout: CheckoutState): Promise<Booking> {
  const policies = await policiesFor(deps, booking.shopSlug);
  const decision = decide(booking, { type: "confirm_deposit", actor: "system" }, deps.clock.now(), policies);
  if (decision instanceof FrontDeskError) throw decision;
  const updated = await deps.store.transition(
    booking.id,
    "awaiting_deposit",
    decision.nextStatus,
    {
      actor: "system",
      type: "deposit.paid",
      data: {
        from: "awaiting_deposit",
        to: decision.nextStatus,
        depositEffect: decision.depositEffect,
        depositCollected: true,
        checkoutSessionId: checkout.id,
        paymentIntentId: checkout.paymentIntentId,
      },
    },
    { state: "held", ...(checkout.paymentIntentId ? { paymentIntentId: checkout.paymentIntentId } : {}) },
  );
  // Another read confirmed it (or something else changed it) first: show it as it is now.
  if (!updated) return (await deps.store.getBooking(booking.id)) ?? booking;
  // The owner hears about a booking once it's confirmed, never about one still waiting for its deposit.
  // A failed alert is recorded, not thrown.
  await alertOwner(deps, "booking_confirmed", updated);
  return updated;
}

/** The awaiting_deposit booking wasn't paid by pay_by: expire it, then close its payment page. */
async function expireUnpaid(deps: FrontDeskDeps, booking: Booking, record: DepositRecord): Promise<Booking> {
  const policies = await policiesFor(deps, booking.shopSlug);
  const decision = decide({ ...booking, payBy: record.payBy }, { type: "expire", actor: "system" }, deps.clock.now(), policies);
  if (decision instanceof FrontDeskError) throw decision;
  const updated = await deps.store.transition(booking.id, "awaiting_deposit", decision.nextStatus, {
    actor: "system",
    type: "expired",
    data: {
      from: "awaiting_deposit",
      to: decision.nextStatus,
      depositEffect: decision.depositEffect,
      depositCollected: depositCollected(booking, decision.depositEffect),
    },
  });
  if (!updated) return (await deps.store.getBooking(booking.id)) ?? booking;
  return moveDeposit(deps, booking, updated, decision.depositEffect);
}

/**
 * The transition result's depositCollected: whether the change moves real money, i.e. the booking had the
 * deposit held on the card (deposit.state "held") and the policy captures or releases it.
 */
export function depositCollected(before: Pick<Booking, "deposit">, effect: DepositEffect): boolean {
  return effect !== "none" && before.deposit.state === "held";
}

/**
 * Move the money a stored transition decided, after the database commit. `before` is the booking as
 * decide() saw it, `after` as the transition left it.
 * - Nothing to do unless the deposit is held, or its payment page is open (awaiting_payment), and the
 *   effect is captured or released.
 * - captured (a no-show, or an agent cancelling inside the window) → capture the hold: deposit captured.
 * - released (complete, cancel in time, the owner cancelling, an unpaid deposit expiring) → release it:
 *   cancel the PaymentIntent, or close the payment page if it's still open: deposit released.
 * - Stripe refuses → the booking change stands. One deposit.action_failed event (actor system,
 *   data { action, message, paymentIntentId?, checkoutSessionId? }) and booking.deposit.actionFailed;
 *   the deposit keeps its state. Retry: TODO(ring-2).
 * Returns the booking as it is afterwards.
 */
export async function moveDeposit(deps: FrontDeskDeps, before: Booking, after: Booking, effect: DepositEffect): Promise<Booking> {
  if (effect === "none") return after;
  if (before.deposit.state !== "held" && before.deposit.state !== "awaiting_payment") return after;
  const record = await deps.store.getDeposit(after.id);
  if (!record) return after;
  const action = effect === "captured" && record.state === "held" ? "capture" : "release";
  try {
    if (!deps.payments) {
      throw new Error("Deposits are off on this deployment (STRIPE_SECRET_KEY isn't set), so Stripe wasn't asked.");
    }
    if (action === "capture") {
      if (!record.paymentIntentId) throw new Error("The deposit has no PaymentIntent to capture.");
      await deps.payments.capture(record.paymentIntentId);
    } else {
      await release(deps.payments, record);
    }
    return (await deps.store.updateDeposit(after.id, { state: action === "capture" ? "captured" : "released", failure: null })) ?? after;
  } catch (err) {
    const message = errorMessage(err);
    logDeposit("deposit.action_failed", after, err);
    const event: NewBookingEvent = {
      actor: "system",
      type: "deposit.action_failed",
      data: {
        action,
        message,
        ...(record.paymentIntentId ? { paymentIntentId: record.paymentIntentId } : {}),
        ...(record.checkoutSessionId ? { checkoutSessionId: record.checkoutSessionId } : {}),
      },
    };
    return (await deps.store.updateDeposit(after.id, { failure: { action, message, at: deps.clock.now() } }, event)) ?? after;
  }
}

/**
 * Release a deposit: cancel the PaymentIntent holding it, or, when the person hasn't paid, close the
 * payment page so they can't any more. A page they paid at the last moment has its hold cancelled.
 */
async function release(payments: DepositPayments, record: DepositRecord): Promise<void> {
  if (record.paymentIntentId) {
    await payments.cancel(record.paymentIntentId);
    return;
  }
  if (!record.checkoutSessionId) return;
  const checkout = await payments.getCheckout(record.checkoutSessionId);
  if (checkout.status === "open") {
    await payments.expireCheckout(checkout.id);
  } else if (checkout.status === "complete" && checkout.paymentIntentId && checkout.paymentIntentStatus === "requires_capture") {
    await payments.cancel(checkout.paymentIntentId);
  }
}
