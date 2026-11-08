# Deposits (Stripe Checkout, test mode)

When a booking needs a deposit, approving it takes the person to a Stripe Checkout page that places a **hold** on their card: the money is authorized, not charged. Paying confirms the booking. The owner's actions then move the money: a no-show or a late cancellation **captures** the hold (the card is charged), and completing the booking or cancelling in time **releases** it.

This page supersedes the "no deposit is collected yet" notes in [frontdesk-api.md](frontdesk-api.md) and the `TODO(ring-1c)` deposit lines there. Shapes are in [`lib/types/deposits.ts`](../lib/types/deposits.ts), re-exported from `lib/types/frontdesk.ts`. The code is in [`lib/server/deposits/`](../lib/server/deposits/).

```
agent             Front Desk                                   person              Stripe
  │ book ────────► │ awaiting_approval (10 min)                   │                   │
  │ send the link ───────────────────────────────────────────────►│                   │
  │                │ ◄── POST …/approve ───────────────────────── │                   │
  │                │ create Checkout Session (manual capture) ───────────────────────►│
  │                │ awaiting_deposit, pay_by = now + 30 min      │                   │
  │                │ ── 303 → Checkout URL ─────────────────────► │ pays (hold) ─────►│
  │                │                                              │ ◄── back to /approve/<token>
  │                │ ◄── GET /approve/<token> (any read) ──────── │                   │
  │                │ retrieve the session ───────────────────────────────────────────►│
  │                │ paid → confirmed, deposit held, owner alerted                     │
  │ get_booking ─► │ confirmed                                                         │
  │                │ owner: no-show → capture ───────────────────────────────────────►│
  │                │ owner: complete → release (cancel the PaymentIntent) ───────────►│
```

## Setup

| | |
|---|---|
| Stripe account | Test mode, the platform account only. Deposits are paid to the account the key belongs to. `TODO(ring-3)`: Stripe Connect, so each shop is paid into its own account. |
| `STRIPE_SECRET_KEY` | The only setting: the account's **test** secret key (`sk_test_…`), from Stripe → Developers → API keys. In Vercel → Settings → Environment Variables, add it (type Secret) for **Preview** and **Production**, then redeploy. Locally, put it in `.env.local`. Never commit it. |
| Test card | `4242 4242 4242 4242`, any future expiry date, any CVC, any postcode. |
| Webhook | None. See [No webhook](#no-webhook-reads-ask-stripe). |

`GET /api/status` gains `deposits`: `"stripe_test"` when `STRIPE_SECRET_KEY` is set, `"off"` when it isn't. **`off` is not a problem**: it never appears in `problems` and never makes the status `not_ready`. The key's value is never shown.

### Deposits off

Without `STRIPE_SECRET_KEY`, everything still books:
- Approving confirms at once, exactly as before. A booking whose service has a deposit shows `deposit.state: "not_collected"`.
- The owner's actions still record `depositEffect` (`released`, `captured`) on the event; `depositCollected` is `false` because nothing was held.
- A booking left `awaiting_deposit` by a deployment that had a key expires when its `pay_by` passes; the release it can't do is recorded as `deposit.action_failed` ("Deposits are off on this deployment…").

## Who needs a deposit

`needsDeposit()` in [`lib/server/engine/lifecycle.ts`](../lib/server/engine/lifecycle.ts): the booking's deposit (`depositCents`, the snapshot taken at booking) is more than 0, **and** its start is before now + `depositHorizonDays` (6 for Hart's), counted in calendar days in the shop's zone like the booking horizon. `book` never places a deposit service further ahead than that, so in practice it's every Haircut and Haircut + beard trim, and never a Beard trim. If the owner shortens the horizon after a booking was made, a booking now beyond it is confirmed without a deposit (`not_collected`).

## The lifecycle

| Status | Deposit state | Meaning |
|---|---|---|
| `awaiting_approval` | `none` | The hold on the time; the person hasn't approved. Nothing asked for. |
| `awaiting_deposit` | `awaiting_payment` | The person approved; they must pay the hold on Stripe Checkout by `pay_by` (approve + 30 minutes). **Holds the time** (the `no_overlap` constraint covers it). |
| `confirmed` | `held` | Paid: authorized on the card, not charged. The owner was alerted. |
| `confirmed` | `not_collected` | Confirmed without a deposit (deposits off, or beyond the horizon). |
| `confirmed` | `none` | A service without a deposit. |
| `expired` | `released` | Approved but not paid by `pay_by`. The time is free again; the payment page was closed. |
| `no_show`, `cancelled` | `captured` | The shop kept the deposit: the hold was charged. |
| `completed`, `cancelled` | `released` | The hold was dropped: the person keeps their money. |

### Transitions and money

`decide()` decides every status change and its `depositEffect` (see [The booking lifecycle](frontdesk-api.md#the-booking-lifecycle)). New rows:

| Who | Action | From | When | Result | `depositEffect` |
|---|---|---|---|---|---|
| customer | approve | `awaiting_approval` | before `approveBy`, a deposit needed, deposits on | `awaiting_deposit` | `none` |
| system | `confirm_deposit` (the person paid) | `awaiting_deposit` | any time, even after `pay_by` | `confirmed` | `none` |
| system | expire (not paid) | `awaiting_deposit` | at or after `pay_by` | `expired` | `released` |

Then, **after the database commit**, `moveDeposit()` in [`deposits.ts`](../lib/server/deposits/deposits.ts) moves the money the effect calls for, if the deposit is `held` (or its page is still `awaiting_payment`):

| Effect | Comes from | In Stripe | `deposit.state` |
|---|---|---|---|
| `captured` | owner no-show; agent `cancel` inside `cancelWindowHours` | capture the PaymentIntent | `captured` |
| `released` | owner complete; agent `cancel` in time; owner cancel; agent `cancel` of an `awaiting_deposit` booking; an unpaid deposit expiring | cancel the PaymentIntent, or expire the Checkout Session if it's still open (a session paid at the last moment has its hold cancelled) | `released` |

Decline only happens before approval, when nothing has been asked for, so it moves no money. The owner cancelling always releases (the shop called it off), as `decide()` already said.

**A Stripe failure never undoes the booking change.** The booking keeps its new status, the deposit keeps its state, and Front Desk records:
- one `deposit.action_failed` event (actor `system`): `{ action: "capture" | "release", message, paymentIntentId?, checkoutSessionId? }`;
- `booking.deposit.actionFailed: { action, message, at }`, which the owner's bookings list (and every other booking response) shows. A later capture or release that succeeds clears it.

Retrying a failed one: `TODO(ring-2)`. Until then the owner captures or cancels the PaymentIntent in the Stripe dashboard (its id is in the event).

### No webhook: reads ask Stripe

Whenever the server reads a booking that is `awaiting_deposit`, `syncDeposit()` retrieves its Checkout Session (with the PaymentIntent expanded):
- **Paid** (session `complete`, PaymentIntent `requires_capture`) → `confirmed`, deposit `held`, the PaymentIntent's id stored, one `deposit.paid` event, then the owner alert, exactly as an approval without a deposit alerts today. This holds even after `pay_by`: Stripe took the hold, so the time is theirs.
- **Not paid and `pay_by` has passed** → `expired` (one `expired` event, actor `system`), then `moveDeposit` releases: the Checkout Session is expired so it can't be paid any more.
- **Otherwise, or if Stripe doesn't answer** → unchanged; the next read asks again (a failed retrieve is logged as `deposit.sync_failed`).

The reads that do this: the approval page and `GET /api/approvals/[token]` (Stripe's `success_url` and `cancel_url` both land there), `get_booking`, the owner's bookings list and booking detail, the owner's and agent's actions (before deciding), and `book` (for a lapsed `awaiting_deposit` booking in the way of the time it's booking, so an unpaid one never blocks a new booking). `get_availability` only reads: it stops counting an `awaiting_deposit` booking once its `pay_by` has passed, like a lapsed approval hold. `TODO(ring-2)`: a webhook (and a scheduled job), so a booking confirms without anyone reading it.

**Timing.** `pay_by` is approve time + 30 minutes on Front Desk's clock (`FRONTDESK_NOW` freezes it, so a frozen clock never expires an unpaid deposit, like `approve_by`). The Checkout Session's own `expires_at` is 31 minutes on real time: Stripe's minimum is 30 minutes after creation, and the extra minute keeps a slow request above it. Front Desk closes the session itself when `pay_by` passes.

## The API

### `Booking.deposit`

Every `Booking` (book, get_booking, cancel, the approval routes, the owner's list, detail and actions) carries:

```json
"deposit": {
  "amountCents": 1000,
  "state": "awaiting_payment",
  "payUrl": "https://checkout.stripe.com/c/pay/cs_test_…",
  "payBy": "2026-11-09T12:30:00-05:00"
}
```

- `state`: `none`, `awaiting_payment`, `held`, `captured`, `released`, `not_collected` (table above).
- `payUrl` and `payBy`: only while `awaiting_payment`.
- `actionFailed`: only after a capture or release Stripe refused.
- `depositCents` stays, the same as `amountCents`.

While a booking is `awaiting_deposit` it also keeps `approval` (`url` the same link, `expiresAt` = `pay_by`), so an agent can send the person the same link again; its page has the Pay button.

### Approving

`POST /api/approvals/[token]/approve` on a booking that needs a deposit:
1. Creates a Checkout Session: `mode: "payment"`, one line item of `depositCents` USD named "Deposit: Haircut at Hart's Barbers, Sat 14 Nov, 2:00 pm EST", `payment_intent_data.capture_method: "manual"`, `success_url` and `cancel_url` both `<origin>/approve/<token>` (the request's origin), `metadata.booking_id`. If Stripe fails here, nothing is stored and the approve answers `internal`, so the person can try again.
2. In one transaction, only if the hold is still on: the booking becomes `awaiting_deposit` with the session's id and URL and `pay_by`, and the approval is marked approved.
3. Answers:
   - a form post (the approval page's Approve button): **303 → the Checkout URL**;
   - JSON: `ApproveResponse` with `booking.status: "awaiting_deposit"` and `booking.deposit.payUrl`.

The owner is alerted when it's paid, not on approve. A booking that doesn't need a deposit is confirmed as before (form post: 303 → `/approve/<token>`).

```bash
T=<the token at the end of approval.url>
curl -s -X POST http://localhost:3000/api/approvals/$T/approve -H "Content-Type: application/json" -d '{}'
# → { "booking": { "status": "awaiting_deposit", "deposit": { "state": "awaiting_payment", "payUrl": "https://checkout.stripe.com/…", … }, … } }
```

### `ApprovalView`

- `status` gains `awaiting_deposit` (approved; the deposit is due). `expired` now also covers an approved booking whose deposit wasn't paid in time, or that was cancelled afterwards.
- `deposit`: `{ amountCents, state, payUrl?, payBy? }` (no `actionFailed`; that's for the owner).

The page at `/approve/[token]` shows, for `awaiting_deposit` only, "Pay the $10 deposit to finish booking", a **Pay $10 deposit** button (the Checkout URL) and "Hold expires at …". It's a plain stand-in; v0 restyles it.

### Transition results

`BookingTransitionResult.depositCollected` (cancel, and the owner's cancel, complete and no-show) is now a `boolean` (it was the literal `false`): `true` when the booking had its deposit `held` and this change captures or releases it. `booking.deposit` shows the outcome.

### Events

| `type` | Actor | `data` |
|---|---|---|
| `approved` | customer | `{ from: "awaiting_approval", to: "awaiting_deposit", depositEffect: "none", depositCollected: false }` |
| `deposit.paid` | system | `{ from: "awaiting_deposit", to: "confirmed", depositEffect: "none", depositCollected: true, checkoutSessionId, paymentIntentId }` |
| `expired` | system | `{ from: "awaiting_deposit", to: "expired", depositEffect: "released", depositCollected: false }` |
| `deposit.action_failed` | system | `{ action, message, paymentIntentId?, checkoutSessionId? }` (no status change) |

Transitions of a booking with a held deposit say `depositCollected: true`.

### What agents read

- `book`'s text: "After approving, Maya pays a $10 deposit hold on the same page (charged only for a no-show or a late cancellation); the booking is confirmed once it's paid. Nothing was charged yet." With deposits off: "This service has a $10 deposit, but the shop isn't collecting deposits yet, so nothing will be charged."
- `get_booking` on `awaiting_deposit`: "Maya approved it, but it isn't confirmed until they pay the $10 deposit hold by Mon 9 Nov, 12:30 pm UTC-5. Send them the same approval link again if needed (its page has the Pay button): <approval url>. Then call get_booking again." The deposit line reads `Deposit: $10 (waiting for payment).` (or `held on the card, not charged`, `charged`, `released`, `not collected`).
- `cancel`'s text adds what happened to the money: "The hold on the card was released.", "The held deposit was charged.", or "No deposit was held on the card, so nothing was charged or refunded."

## Database: `0005_deposits.sql`

[`supabase/migrations/0005_deposits.sql`](../supabase/migrations/0005_deposits.sql) adds to `bookings`:

| Column | Type | What |
|---|---|---|
| `checkout_session_id` | text, null | The Checkout Session opened on approve. |
| `checkout_url` | text, null | Its URL: `deposit.payUrl` and the Pay button. |
| `payment_intent_id` | text, null | The PaymentIntent holding the deposit, once paid. |
| `pay_by` | timestamptz, null | When an `awaiting_deposit` booking lapses. Required while `awaiting_deposit` (`bookings_deposit_has_deadline`). |
| `deposit_state` | text, not null, default `'none'` | `deposit.state`; checked against the six states. |
| `deposit_failure` | jsonb, null | The last refused capture or release, `{ action, message, at }`. |

It's additive (nullable columns, one with a default; no new table, so no new RLS line) and compatible with the code already deployed: old code never writes `awaiting_deposit`, so the new check never fires on its writes. Existing bookings get `deposit_state = 'none'`, except confirmed, completed and no-show ones with a deposit, which never collected it: `not_collected`. Every new column is in `REQUIRED_SCHEMA` ([`schema.ts`](../lib/server/frontdesk/schema.ts)), so `/api/status` says `outdated` until 0005 is applied. It's applied like any migration: by the Preview database workflow for this PR, and by the GitHub integration on merge.

## Tests

- [`lib/server/deposits/deposits.test.ts`](../lib/server/deposits/deposits.test.ts), with a stubbed Stripe ([`stub-payments.ts`](../lib/server/deposits/stub-payments.ts)): the needs-deposit rules; approve → `awaiting_deposit` (and the 303 / JSON answers); paid → `confirmed` and the owner alerted once; unpaid past `pay_by` → `expired`, the page closed, the time bookable; capture and release on each transition; a Stripe failure recorded without undoing the change; deposits off without a key; what agents read.
- [`lib/server/deposits/stripe.test.ts`](../lib/server/deposits/stripe.test.ts): the real `stripe` package with a recording fetch: the exact Checkout Session parameters, the expanded retrieve, and the expire, capture and cancel endpoints.
- [`lib/server/deposits/deposits-pg.test.ts`](../lib/server/deposits/deposits-pg.test.ts): the same flow on Postgres (0005's columns), with `DATABASE_URL_TEST`.
- `pnpm smoke`: item 19 in [SMOKE.md](../SMOKE.md). With `deposits: "stripe_test"` it approves a Haircut and expects `awaiting_deposit` with a `checkout.stripe.com` URL, never pays, then cancels it and checks the time is free. With `off` it expects `confirmed` and `not_collected`.

## Not built yet

- A webhook and a scheduled job (`TODO(ring-2)`): today a booking moves only when something reads it.
- Retrying a failed capture or release (`TODO(ring-2)`).
- Stripe Connect, paying each shop (`TODO(ring-3)`).
- Refunding a captured deposit, and capturing less than the whole deposit.
- Live mode. The key is whatever `STRIPE_SECRET_KEY` holds; use a test key.
