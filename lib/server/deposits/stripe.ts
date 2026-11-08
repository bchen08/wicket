import Stripe from "stripe";
import type { CheckoutState, DepositPayments } from "./payments";

// DepositPayments over Stripe, with the official `stripe` package. Test mode on the platform account:
// the deposit goes to the account STRIPE_SECRET_KEY belongs to. TODO(ring-3): Stripe Connect, so each
// shop is paid into its own account.

/**
 * How long a Checkout Session stays open. Stripe requires at least 30 minutes from creation; one more
 * minute keeps a slow request from falling under that. The booking itself waits 30 minutes (pay_by);
 * after that the server expires the session (deposits.ts).
 */
export const CHECKOUT_OPEN_MINUTES = 31;

/** Every Stripe request gets this long, once retried on a network error. */
const STRIPE_TIMEOUT_MS = 8_000;

function toCheckoutState(session: Stripe.Checkout.Session): CheckoutState {
  const intent = session.payment_intent;
  const status: CheckoutState["status"] =
    session.status === "complete" ? "complete" : session.status === "expired" ? "expired" : "open";
  return {
    id: session.id,
    status,
    paymentIntentId: typeof intent === "string" ? intent : (intent?.id ?? null),
    paymentIntentStatus: typeof intent === "string" || intent === null ? null : intent.status,
  };
}

/**
 * DepositPayments for the Stripe account `secretKey` belongs to (sk_test_…). `options.fetch` replaces the
 * network, for tests (stripe.test.ts records what the SDK would send).
 */
export function createStripePayments(secretKey: string, options: { fetch?: typeof fetch } = {}): DepositPayments {
  const stripe = new Stripe(secretKey, {
    maxNetworkRetries: 1,
    timeout: STRIPE_TIMEOUT_MS,
    ...(options.fetch ? { httpClient: Stripe.createFetchHttpClient(options.fetch), maxNetworkRetries: 0 } : {}),
  });
  return {
    async createCheckout({ bookingId, amountCents, description, returnUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: { currency: "usd", unit_amount: amountCents, product_data: { name: description } },
          },
        ],
        // A hold: the card is authorized now and charged only if the shop captures it.
        payment_intent_data: { capture_method: "manual", description, metadata: { booking_id: bookingId } },
        client_reference_id: bookingId,
        metadata: { booking_id: bookingId },
        success_url: returnUrl,
        cancel_url: returnUrl,
        // Stripe's clock, not Front Desk's (FRONTDESK_NOW may freeze that one).
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_OPEN_MINUTES * 60,
      });
      if (!session.url) throw new Error(`Stripe returned Checkout Session ${session.id} without a URL.`);
      return { id: session.id, url: session.url };
    },

    async getCheckout(id) {
      return toCheckoutState(await stripe.checkout.sessions.retrieve(id, { expand: ["payment_intent"] }));
    },

    async expireCheckout(id) {
      await stripe.checkout.sessions.expire(id);
    },

    async capture(paymentIntentId) {
      await stripe.paymentIntents.capture(paymentIntentId);
    },

    async cancel(paymentIntentId) {
      await stripe.paymentIntents.cancel(paymentIntentId);
    },
  };
}
