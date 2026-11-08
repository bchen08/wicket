import { describe, expect, it } from "vitest";
import { CHECKOUT_OPEN_MINUTES, createStripePayments } from "./stripe";

// The Stripe adapter through the real `stripe` package, with the network replaced by a recording fetch:
// what each call sends to Stripe, and how Stripe's answers are read. No request leaves the machine.

type Sent = { method: string; url: URL; body: URLSearchParams; auth: string | null };

function recordingFetch(answer: (sent: Sent) => unknown) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const request: Sent = {
      method: init?.method ?? "GET",
      url,
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      auth: headers.get("authorization"),
    };
    sent.push(request);
    return new Response(JSON.stringify(answer(request)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, sent };
}

const SESSION = {
  id: "cs_test_123",
  object: "checkout.session",
  url: "https://checkout.stripe.com/c/pay/cs_test_123",
  status: "open",
  payment_intent: null,
};

describe("createStripePayments", () => {
  it("createCheckout: a payment-mode session for a manual-capture hold, returning to the approval page, open 31 minutes", async () => {
    const { fetchFn, sent } = recordingFetch(() => SESSION);
    const payments = createStripePayments("sk_test_abc", { fetch: fetchFn });
    const before = Math.floor(Date.now() / 1000);
    const session = await payments.createCheckout({
      bookingId: "b-1",
      amountCents: 1000,
      description: "Deposit: Haircut at Hart's Barbers, Sat 14 Nov, 2:00 pm EST",
      returnUrl: "https://emergent.vercel.app/approve/tok",
    });
    expect(session).toEqual({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" });

    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req.method).toBe("POST");
    expect(req.url.href).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(req.auth).toBe("Bearer sk_test_abc");
    const body = Object.fromEntries(req.body);
    expect(body).toMatchObject({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "1000",
      "line_items[0][price_data][product_data][name]": "Deposit: Haircut at Hart's Barbers, Sat 14 Nov, 2:00 pm EST",
      "payment_intent_data[capture_method]": "manual",
      "payment_intent_data[metadata][booking_id]": "b-1",
      client_reference_id: "b-1",
      "metadata[booking_id]": "b-1",
      success_url: "https://emergent.vercel.app/approve/tok",
      cancel_url: "https://emergent.vercel.app/approve/tok",
    });
    const expiresAt = Number(body.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + CHECKOUT_OPEN_MINUTES * 60);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + CHECKOUT_OPEN_MINUTES * 60);
  });

  it("getCheckout expands the PaymentIntent and reads its status; expire, capture and cancel hit their endpoints", async () => {
    const { fetchFn, sent } = recordingFetch((req) => {
      if (req.url.pathname === "/v1/checkout/sessions/cs_test_123") {
        return { ...SESSION, status: "complete", payment_intent: { id: "pi_1", object: "payment_intent", status: "requires_capture" } };
      }
      if (req.url.pathname.startsWith("/v1/checkout/sessions/")) return { ...SESSION, status: "expired" };
      return { id: "pi_1", object: "payment_intent", status: "succeeded" };
    });
    const payments = createStripePayments("sk_test_abc", { fetch: fetchFn });

    expect(await payments.getCheckout("cs_test_123")).toEqual({
      id: "cs_test_123",
      status: "complete",
      paymentIntentId: "pi_1",
      paymentIntentStatus: "requires_capture",
    });
    expect(sent[0].method).toBe("GET");
    expect(sent[0].url.searchParams.getAll("expand[0]")).toEqual(["payment_intent"]);

    await payments.expireCheckout("cs_test_9");
    await payments.capture("pi_1");
    await payments.cancel("pi_2");
    expect(sent.slice(1).map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /v1/checkout/sessions/cs_test_9/expire",
      "POST /v1/payment_intents/pi_1/capture",
      "POST /v1/payment_intents/pi_2/cancel",
    ]);
  });

  it("an open session without a PaymentIntent reads as open with none", async () => {
    const { fetchFn } = recordingFetch(() => SESSION);
    const payments = createStripePayments("sk_test_abc", { fetch: fetchFn });
    expect(await payments.getCheckout("cs_test_123")).toEqual({
      id: "cs_test_123",
      status: "open",
      paymentIntentId: null,
      paymentIntentStatus: null,
    });
  });
});
