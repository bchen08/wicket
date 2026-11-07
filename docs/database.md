# Database (Supabase Postgres)

Front Desk stores shops, services, staff hours, booking rules, blocked time, bookings and their history in Postgres, hosted on Supabase.

| File | What it is |
|---|---|
| [`supabase/migrations/0001_skeleton.sql`](../supabase/migrations/0001_skeleton.sql) | Ring 0: shops, services, staff, weekly hours, bookings, the no-double-booking constraint, row level security |
| [`supabase/migrations/0002_rules.sql`](../supabase/migrations/0002_rules.sql) | Ring 1a: shop policies, blocked times, the full booking lifecycle (statuses, timestamps, deposit snapshot), the events log, idempotency keys |
| [`supabase/seed.sql`](../supabase/seed.sql) | Demo data: Hart's Barbers, its 3 services, staff member Dana, Tue–Sat hours, and Hart's policies. No bookings or blocked times. Needs 0002. Safe to run more than once. |

## Schema in one minute

- `shops (slug, name, timezone)`
- `services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)`
- `staff (id, shop_slug, name)`
- `weekly_hours (staff_id, weekday 1–7 ISO, opens, closes)`: several rows per day are allowed. Lunch is the gap between `09:00–12:00` and `12:30–17:00`.
- `bookings (id, shop_slug, service_id, staff_id, during tstzrange, status, customer_name, agent_name, created_at, cancelled_at, cancelled_by, completed_at, no_show_at, deposit_cents)`
  - `status` is one of `awaiting_deposit`, `confirmed`, `cancelled`, `expired`, `completed`, `no_show`. Ring 1a only writes `confirmed`, `cancelled`, `completed` and `no_show`.
  - `cancelled_by` is `agent` or `owner`. Each transition stamps its own time column.
  - `deposit_cents` is a snapshot of the service's deposit when the booking was made, so a later price change doesn't rewrite history.
- `policies (shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone, deposit_rule, late_cancel_rule, no_show_rule, updated_at)`: one row per shop. A shop without a row uses the column defaults (120 minutes, 30 days, 6 days, 24 hours, not paused, no phone, empty rules).
- `blocked_times (id, staff_id, during tstzrange, reason, created_at)`: holidays and time off. Half-open, like bookings. The owner sees `reason`; agents never do.
- `events (id, booking_id, at, actor, type, data jsonb)`: one row per booking state change (`booked`, `cancelled`, `completed`, `no_show`), written in the same transaction as the change. `actor` is `agent`, `owner` or `system`.
- `idempotency_keys (key, tool, request_hash, response jsonb, created_at)`, primary key `(key, tool)`: the first successful `book` or `cancel` call with a key saves its response, and a retry with the same key and arguments gets it back. A key may be reused after 24 hours. Old keys aren't deleted yet (`TODO(ring-2)`).

Double booking is impossible at the database level:

```sql
constraint no_overlap exclude using gist (staff_id with =, during with &&)
  where (status in ('awaiting_deposit', 'confirmed'))
```

Two bookings that hold time (`awaiting_deposit` or `confirmed`) for the same staff member can't overlap. Cancelled, expired, completed and no-show bookings free their time. `during` is half-open (`[start, end)`), so back-to-back bookings are fine. When the constraint fires, Postgres raises SQLSTATE `23P01`, and the `book` tool returns `slot_taken`. If two overlapping inserts arrive at the same moment, Postgres can also abort one with `40P01` (deadlock). The server retries that insert, which then fails cleanly with `23P01`.

Booking state changes are conditional: `UPDATE bookings … WHERE id = … AND status = <expected>`, with the event inserted in the same statement. Of two concurrent changes to one booking, only one matches; the other writes nothing.

**Access model:** the Next.js server connects as the database owner through `DATABASE_URL`. The browser never talks to the database. Row level security is enabled on every table with **no policies**, so Supabase's public API keys (`anon`, `authenticated`) can't read or write anything.

### Database time and `FRONTDESK_NOW`

`created_at`, `events.at`, `cancelled_at`, `completed_at`, `no_show_at` and `idempotency_keys.created_at` are set by the database with `now()` (the start of the transaction). `FRONTDESK_NOW` freezes only Front Desk's own clock, which drives the booking rules (see [frontdesk-api.md](frontdesk-api.md)). So with Postgres:
- `createdAt`, event times and the lifecycle timestamps show real time, even when the app clock is frozen.
- Idempotency keys expire 24 real hours after their first use, measured on the database's clock, even when `FRONTDESK_NOW` is set.

The in-memory store (no `DATABASE_URL`) stamps all of these with the app clock instead, so with `FRONTDESK_NOW` set they show the frozen instant, and keys never expire.

## Set up a Supabase project

### 1. Apply the migrations, then the seed

On a new database, run the files in this order: `0001_skeleton.sql`, then `0002_rules.sql`, then `seed.sql`. The seed needs 0002, because it inserts Hart's policies.

**Option A: Supabase SQL editor.** In the Supabase dashboard, open **SQL Editor**. Paste the whole of `supabase/migrations/0001_skeleton.sql` and click **Run**. Then do the same with `supabase/migrations/0002_rules.sql`, then `supabase/seed.sql`.

**Option B: Supabase CLI.**

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

`db push` applies the migrations in `supabase/migrations/` that the project hasn't run yet: both, on a new project. It doesn't load the seed. Load it from the SQL editor (Option A), or with `psql`:

```bash
psql "<direct or session connection string>" -f supabase/seed.sql
```

To check it worked, run `select * from services;` in the SQL editor. You should see three rows. `select * from policies;` should show one row, for `harts`.

### Upgrading a database that already has 0001

1. **Apply `0002_rules.sql`, once.**
   - SQL editor: paste the whole file and click **Run**.
   - Or `supabase db push`, which runs only the migrations missing from the project's migration history. If you applied 0001 in the SQL editor, that history doesn't list it, and `db push` would try to run 0001 again and fail. In that case use the SQL editor for 0002 too.
2. **Re-run `seed.sql`, after 0002.** It now also inserts Hart's policies. It's safe to re-run: every insert is `on conflict do nothing`, so it never overwrites an existing policies row, and an owner's changes stay.
3. Check: `select * from policies;` shows one row, for `harts`.

What 0002 does to existing data:
- Existing bookings keep their status (`confirmed` and `cancelled` are still valid). Each gets `deposit_cents` from its service's current deposit.
- The new tables start empty, so old bookings have no events.
- 0002 can't be run twice: the second run fails because its tables already exist.

### 2. Get the connection string: use the transaction pooler

In the Supabase dashboard, click **Connect**, choose **Transaction pooler**, and copy the URI. It looks like:

```
postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

`DATABASE_URL` **must be the transaction pooler string (port 6543)**, not the direct connection (port 5432):
- Vercel runs every request in a short-lived serverless function. The pooler shares a small number of real database connections between them.
- The direct connection can run out of connections under load, and it's IPv6-only on some plans.

The code connects with `prepare: false`, which the transaction pooler requires.

### 3. Set `DATABASE_URL`

**Locally:** put it in `.env.local`, which is git-ignored. Never commit it.

```bash
DATABASE_URL=postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

**On Vercel:** go to **Project → Settings → Environment Variables** and add `DATABASE_URL` for **Preview** and **Production**. Redeploy afterwards, because environment variables apply to new deployments only.

### 4. Set `OWNER_API_TOKEN`

`OWNER_API_TOKEN` protects the owner routes: policies, hours, blocked time, adding and changing services, the booking actions (cancel, complete, no-show) and a booking's history. Callers send it as `Authorization: Bearer <OWNER_API_TOKEN>`. See [frontdesk-api.md](frontdesk-api.md#owner-routes). The MCP tools and the public `GET` services and bookings routes don't use it.

Use at least 16 random characters, for example:

```bash
openssl rand -hex 32
```

**Locally:** put it in `.env.local`, next to `DATABASE_URL`.

```bash
OWNER_API_TOKEN=<64 hex characters>
```

**On Vercel:** add `OWNER_API_TOKEN` for **Preview** and **Production**, then redeploy.

- **Never open.** If it's unset, blank or shorter than 16 characters, every owner route answers **503** with a configuration message. A missing or wrong token in a request is **401**.
- **Never commit it.** Anyone holding it can change the shop's rules and act on its bookings. To rotate it, change the value in Vercel and redeploy.
- It's a stopgap: `TODO(ring-2)`: owner sign-in replaces the token.

## What happens without `DATABASE_URL`

| Where | Behavior |
|---|---|
| Local (`pnpm dev`, tests) | Front Desk uses an in-memory copy of the seed data (including Hart's policies) and logs one warning. Bookings, events and owner changes are lost when the server restarts. Good for UI work without a database. |
| Vercel (the `VERCEL` env var is set) | Every Front Desk call fails with an `internal` error, and the function log says `DATABASE_URL is not set`. A deployment never serves fake data. |

The wiring lives in [`lib/server/frontdesk/deps.ts`](../lib/server/frontdesk/deps.ts).

## Running the Postgres tests

`pnpm test` uses the in-memory store. To also run the tests against a real database, point `DATABASE_URL_TEST` at a **scratch** database with `0001_skeleton.sql`, `0002_rules.sql` and the seed applied:

```bash
DATABASE_URL_TEST=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test
```

Two files use it:

| File | What it covers |
|---|---|
| [`lib/server/frontdesk/postgres-store.test.ts`](../lib/server/frontdesk/postgres-store.test.ts) | The Postgres store itself: overlaps and races (`23P01`, `40P01`), the deposit snapshot and `booked` event, conditional transitions and their timestamps, busy time including blocked time, idempotency keys (replay, conflict, rollback, concurrency, reuse after 24 hours), and the owner writes (policies, services, hours, blocks). |
| [`lib/server/frontdesk/flow-pg.test.ts`](../lib/server/frontdesk/flow-pg.test.ts) | The lifecycle and idempotency flow through the service layer, the code the MCP tools and owner routes call: book and replay, conflicts, cancel (released, captured, none), cancel after the start, an owner no-show, and concurrent books and cancels. |

They only touch rows of their own and delete them afterwards: bookings in 2099, idempotency keys they made, and a throwaway shop for the lifecycle, idempotency and owner-write tests. Hart's seeded rows are read, never changed. Without `DATABASE_URL_TEST` they're skipped, and the test output says so.

A throwaway local database with Docker:

```bash
docker run -d --rm --name frontdesk-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:17-alpine
docker exec -i frontdesk-pg psql -U postgres < supabase/migrations/0001_skeleton.sql
docker exec -i frontdesk-pg psql -U postgres < supabase/migrations/0002_rules.sql
docker exec -i frontdesk-pg psql -U postgres < supabase/seed.sql
```

## Changing the schema

Add a new numbered file, for example `supabase/migrations/0003_<what>.sql`. Never edit a migration that has already been applied to a shared database. If you change the demo data, update `SEED` in [`lib/server/frontdesk/memory-store.ts`](../lib/server/frontdesk/memory-store.ts) to match `supabase/seed.sql`. If you change a policy default or range, update `DEFAULT_POLICIES` and `POLICY_LIMITS` in [`lib/server/frontdesk/policies.ts`](../lib/server/frontdesk/policies.ts) to match the `policies` table.
