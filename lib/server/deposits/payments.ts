// The payment side of deposits, as the deposit use cases (deposits.ts) need it. One implementation talks to
// Stripe (stripe.ts); tests pass a stub. FrontDeskDeps.payments is null when deposits are off (no
// STRIPE_SECRET_KEY), and then nothing here is called.

/** A Checkout Session as the deposit use cases see it. */
export type CheckoutState = {
  id: string;
  /** open: the person can still pay. complete: they paid (the hold is placed). expired: closed unpaid. */
  status: "open" | "complete" | "expired";
  /** The PaymentIntent behind it, once the person paid (or tried to); null before. */
  paymentIntentId: string | null;
  /**
   * That PaymentIntent's status, e.g. "requires_capture" (the deposit is authorized on the card, not
   * charged) or "succeeded" (charged). null when there's no PaymentIntent yet.
   */
  paymentIntentStatus: string | null;
};

/** What a new Checkout Session collects. */
export type NewCheckout = {
  bookingId: string;
  /** The deposit, in integer US cents. */
  amountCents: number;
  /** What the person sees on the payment page, e.g. "Deposit: Haircut at Hart's Barbers, Sat 14 Nov, 2:30 pm EST". */
  description: string;
  /** Where Stripe sends the person back, whether they paid or not: the approval page. */
  returnUrl: string;
};

export interface DepositPayments {
  /**
   * Open a payment page that places a hold for the deposit (charged later only if the shop captures it).
   * It stays open a little over the 30 minutes the booking waits (Stripe's minimum is 30 minutes).
   */
  createCheckout(input: NewCheckout): Promise<{ id: string; url: string }>;
  /** Where a Checkout Session stands, with its PaymentIntent's status. */
  getCheckout(id: string): Promise<CheckoutState>;
  /** Close an open Checkout Session so it can't be paid any more. */
  expireCheckout(id: string): Promise<void>;
  /** Charge the held deposit (the shop keeps it). */
  capture(paymentIntentId: string): Promise<void>;
  /** Drop the held deposit (the person keeps their money). */
  cancel(paymentIntentId: string): Promise<void>;
}

/** Whether a Checkout Session has the deposit on the card: authorized and waiting to be captured, or already charged. */
export function isAuthorized(checkout: CheckoutState): boolean {
  return (
    checkout.status === "complete" &&
    (checkout.paymentIntentStatus === "requires_capture" || checkout.paymentIntentStatus === "succeeded")
  );
}
