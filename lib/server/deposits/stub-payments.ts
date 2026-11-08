// A stand-in for Stripe in tests: Checkout Sessions and PaymentIntents in memory, with switches to pay a
// session or make the next call fail. Not imported by app code.
import type { CheckoutState, DepositPayments, NewCheckout } from "./payments";

type Method = keyof DepositPayments;

export type StubSession = NewCheckout & {
  id: string;
  url: string;
  status: CheckoutState["status"];
  paymentIntentId: string | null;
};

export type StubPayments = DepositPayments & {
  /** Every session created, by id. */
  sessions: Map<string, StubSession>;
  /** Every PaymentIntent's status, by id: requires_capture (held), succeeded (captured), canceled (released). */
  intents: Map<string, string>;
  /** Every call, in order, e.g. "createCheckout", "capture pi_test_1". */
  calls: string[];
  /** The person pays `sessionId`: it completes with an authorized PaymentIntent (requires_capture). Returns its id. */
  pay(sessionId: string): string;
  /** Make the next call to `method` throw an Error with `message`, like a Stripe error. */
  failNext(method: Method, message?: string): void;
  /** The one session created so far (throws unless there is exactly one). */
  onlySession(): StubSession;
};

export function stubPayments(): StubPayments {
  const sessions = new Map<string, StubSession>();
  const intents = new Map<string, string>();
  const calls: string[] = [];
  const failures = new Map<Method, string>();
  let seq = 0;

  function enter(method: Method, arg?: string): void {
    calls.push(arg ? `${method} ${arg}` : method);
    const message = failures.get(method);
    if (message !== undefined) {
      failures.delete(method);
      throw new Error(message);
    }
  }

  function session(id: string): StubSession {
    const s = sessions.get(id);
    if (!s) throw new Error(`No such checkout.session: '${id}'`);
    return s;
  }

  function state(s: StubSession): CheckoutState {
    return {
      id: s.id,
      status: s.status,
      paymentIntentId: s.paymentIntentId,
      paymentIntentStatus: s.paymentIntentId ? (intents.get(s.paymentIntentId) ?? null) : null,
    };
  }

  /** Like Stripe: an intent can only be captured or cancelled while it's held. */
  function moveIntent(id: string, to: "succeeded" | "canceled"): void {
    const status = intents.get(id);
    if (status !== "requires_capture") {
      throw new Error(`This PaymentIntent (${id}) could not be ${to === "succeeded" ? "captured" : "canceled"} because it has a status of ${status ?? "unknown"}.`);
    }
    intents.set(id, to);
  }

  return {
    sessions,
    intents,
    calls,
    pay(sessionId) {
      const s = session(sessionId);
      if (s.status !== "open") throw new Error(`Session ${sessionId} is ${s.status}; it can't be paid.`);
      const intentId = `pi_test_${++seq}`;
      intents.set(intentId, "requires_capture");
      s.status = "complete";
      s.paymentIntentId = intentId;
      return intentId;
    },
    failNext(method, message = "Stripe test failure: the request couldn't be completed.") {
      failures.set(method, message);
    },
    onlySession() {
      if (sessions.size !== 1) throw new Error(`Expected exactly one checkout session, found ${sessions.size}.`);
      return [...sessions.values()][0];
    },

    async createCheckout(input) {
      enter("createCheckout");
      const id = `cs_test_${++seq}`;
      const s: StubSession = { ...input, id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", paymentIntentId: null };
      sessions.set(id, s);
      return { id, url: s.url };
    },
    async getCheckout(id) {
      enter("getCheckout", id);
      return state(session(id));
    },
    async expireCheckout(id) {
      enter("expireCheckout", id);
      const s = session(id);
      if (s.status !== "open") throw new Error(`Only Checkout Sessions with a status in ["open"] can be expired, not ${s.status}.`);
      s.status = "expired";
    },
    async capture(paymentIntentId) {
      enter("capture", paymentIntentId);
      moveIntent(paymentIntentId, "succeeded");
    },
    async cancel(paymentIntentId) {
      enter("cancel", paymentIntentId);
      moveIntent(paymentIntentId, "canceled");
    },
  };
}
