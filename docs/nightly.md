# The nightly tidy-up

Every night Front Desk tidies each shop by itself, so nothing waits on the owner or on someone opening a booking:

- **Past appointments are completed.** A confirmed booking that ended more than 3 hours ago, and that the owner didn't mark completed or a no-show, is marked `completed` (actor `system`), and its deposit hold is released in Stripe.
- **Nothing stays open past its deadline.** A hold awaiting approval past `approve_by`, and a booking awaiting its deposit past `pay_by`, are expired, even if nobody reads them. For an unpaid deposit the Stripe Checkout page is closed, and a hold placed at the last moment is cancelled.

The shapes are in [`lib/types/nightly.ts`](../lib/types/nightly.ts), re-exported from `lib/types/frontdesk.ts`. The code is [`lib/server/frontdesk/nightly.ts`](../lib/server/frontdesk/nightly.ts); the route is [`app/api/jobs/nightly/route.ts`](../app/api/jobs/nightly/route.ts).

## When it runs

[`vercel.json`](../vercel.json) schedules it with Vercel Cron:

```json
{ "crons": [{ "path": "/api/jobs/nightly", "schedule": "0 8 * * *" }] }
```

- Once a day at **08:00 UTC**: 03:00 in New York in winter (EST), 04:00 in summer (EDT). Hart's last appointment ends by 17:00, so every booking that day is more than 3 hours past by then and is completed **by the next morning**.
- The Hobby plan allows one cron run a day, which is all this needs. Hobby runs it at some point within that hour (08:00–08:59 UTC), not on the minute.
- **Production only.** Vercel runs cron jobs on the production deployment, never on previews. On a preview, call it yourself (below).
- Vercel calls the path with a plain `GET`. Nothing else is set up: no secret, no environment variable.

## What one run does

For every shop (`listShops`), in this order:

1. **Expire what lapsed.**
   - Holds awaiting approval past `approve_by`: `store.expireStaleHolds` over all time, the same statement `book`'s lazy expiry runs. One `expired` event each (actor `system`). No money is involved in a hold.
   - Bookings awaiting their deposit past `pay_by`: `syncDeposit`, the code every read of such a booking runs ([deposits.md](deposits.md#no-webhook-reads-ask-stripe)). It asks Stripe first:
     - not paid → `expired` (one `expired` event, actor `system`), then the release closes the Checkout page (`deposit.state: "released"`);
     - paid after all (at the last moment, and nobody read it since) → `confirmed`, deposit `held`, and the owner is alerted, exactly as on any read. Stripe holds the money, so the time is theirs. Not counted;
     - Stripe doesn't answer → left as it is (the time stays held) and counted in `failures`. The next read or the next run asks again.
2. **Complete past appointments.** Every confirmed booking whose end is more than 3 hours before now (`COMPLETE_AFTER_HOURS`) goes through `transitionBooking(…, "complete", "system")`, the owner's complete path: `decide()` allows the `system` actor to complete a confirmed booking after its start, by the same rule as the owner. One `completed` event (actor `system`, `depositEffect: "released"`), `completed_at` stamped, then `moveDeposit` releases the hold (cancels the PaymentIntent): `deposit.state: "released"`.
   - A booking without a deposit, or whose deposit wasn't collected (`none`, `not_collected`), is completed without asking Stripe.
   - A booking the owner changed after the list was read (marked a no-show, say) is skipped: `decide()` refuses, and there's nothing left to do. Not a failure.

Then it writes one row to `nightly_runs` and answers with it.

### Counts

| Field | What |
|---|---|
| `expired` | Holds and unpaid deposits this run expired. |
| `completed` | Past confirmed bookings this run completed. |
| `depositsReleased` | Deposits this run released: a completed booking's hold dropped, or an expired booking's unpaid Checkout page closed. Deposits never held aren't counted. |
| `failures` | Bookings this run couldn't finish (see below). Each one is in the function log as a `nightly.*` JSON line. |

### Failures don't stop the run

- **Stripe refuses a release** (cancelling the PaymentIntent, or closing the Checkout page): the booking keeps its new status (`completed` or `expired`), and `moveDeposit` records it like any other refused capture or release: a `deposit.action_failed` event (actor `system`) and `booking.deposit.actionFailed`, which the owner's list shows ([deposits.md](deposits.md#transitions-and-money)). The run counts it in `failures` and goes on to the next booking. Retrying it: `TODO(ring-2)`, as for the owner's actions; until then the owner cancels the PaymentIntent in the Stripe dashboard (its id is in the event).
- **Stripe doesn't answer whether a deposit was paid**: counted, left for the next run.
- **Any other error on one booking** (a lost database connection, say): counted, logged, and the next booking still runs. A shop that can't be read at all counts as one failure and the next shop still runs.
- If the database is down, the run can't be recorded and the route answers `500 internal` in the `ApiError` envelope.

### Safe to run twice

Each step picks only bookings still in the status it changes, and every change is conditional on that status (`UPDATE … WHERE status = <expected>`), so a second run, or one running at the same time as an owner's action or another run, finds nothing left to do: all four counts `0`, no new events, no Stripe calls. A refused release isn't retried by the next run (the booking is already `completed`).

## The API

### `GET /api/jobs/nightly` → `NightlyRunResponse`

Public: no token, like `/api/status`. Request-time only, `Cache-Control: no-store`.

```bash
curl -s https://<deployment>/api/jobs/nightly
# → { "ranAt": "2026-11-11T08:00:04.512Z", "expired": 1, "completed": 4, "depositsReleased": 3, "failures": 0 }
```

- `ranAt`: when the run finished and was recorded, RFC 3339 in UTC (a run covers every shop). With Postgres it's the database's time, so freezing Front Desk's clock with `FRONTDESK_NOW` doesn't freeze it; the run itself decides by Front Desk's clock, like every other expiry.
- Errors: `500 internal` when the database can't be reached or the run can't be recorded.

### `GET /api/status` → `lastNightlyRun`

`StatusResponse.lastNightlyRun` is the newest row in `nightly_runs`: the same shape as the answer above. `null` when it has never run against this database (every preview until someone calls the route), or when it can't be read (the database is unreachable, or 0006 isn't applied, which `database.missing` already names). It's never one of `problems`.

## Database: `0006_nightly.sql`

[`supabase/migrations/0006_nightly.sql`](../supabase/migrations/0006_nightly.sql) adds one table, with RLS on and no policies:

| Column | Type | What |
|---|---|---|
| `id` | bigint identity | |
| `ran_at` | timestamptz, default `now()` | When the run finished. |
| `expired`, `completed`, `deposits_released`, `failures` | integer | The counts. |

One row per run, newest read by `(ran_at desc, id desc)`. It's additive, changes no existing data, and is in `REQUIRED_SCHEMA`, so `/api/status` says `outdated` until it's applied. See [database.md](database.md#the-nightly-tidy-up-applying-0006).

## Tests

- [`lib/server/frontdesk/nightly.test.ts`](../lib/server/frontdesk/nightly.test.ts), in memory with a stubbed Stripe: a past confirmed booking completed and its hold released (actor `system`); a future one, and one that ended 3 hours ago or less, untouched; a booking without a deposit or with deposits off; a booking the owner marked meanwhile skipped; lapsed holds and unpaid deposits expired (the Checkout page closed), a deposit paid at the last moment confirmed, a live hold untouched; a second run changing nothing; a refused release recorded and counted while the next booking is still released; Stripe not answering; an error on one booking; the route's answer and `/api/status`.
- [`lib/server/frontdesk/nightly-pg.test.ts`](../lib/server/frontdesk/nightly-pg.test.ts): the same on Postgres, for a throwaway shop only, with `DATABASE_URL_TEST`.
- [`lib/server/engine/lifecycle.test.ts`](../lib/server/engine/lifecycle.test.ts): `system` may complete a confirmed booking after its start, and nothing else new.
- `pnpm smoke`: item 23 in [SMOKE.md](../SMOKE.md). Where `/api/status` says `writesAllowed`, it calls `/api/jobs/nightly`, checks the four counts come back, and checks `/api/status` shows that run as `lastNightlyRun`.

## Security not built

The route has no secret: anyone can call it, as often as they like. That's on purpose. It only does what Front Desk would do anyway once a booking's time has passed: expire holds and unpaid deposits past their deadline, and complete confirmed bookings that ended more than 3 hours ago. Calling it early changes nothing that isn't already due. Vercel's `CRON_SECRET` would close it if that ever matters.
