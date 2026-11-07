# Database (Supabase Postgres)

Front Desk stores shops, services, staff hours and bookings in Postgres, hosted on Supabase.

| File | What it is |
|---|---|
| [`supabase/migrations/0001_skeleton.sql`](../supabase/migrations/0001_skeleton.sql) | Tables, the no-double-booking constraint, row level security |
| [`supabase/seed.sql`](../supabase/seed.sql) | Demo data: Hart's Barbers, its 3 services, staff member Dana, Tue–Sat hours. No bookings. Safe to run more than once. |

## Schema in one minute

- `shops (slug, name, timezone)`
- `services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)`
- `staff (id, shop_slug, name)`
- `weekly_hours (staff_id, weekday 1–7 ISO, opens, closes)`: several rows per day are allowed. Lunch is the gap between `09:00–12:00` and `12:30–17:00`.
- `bookings (id, shop_slug, service_id, staff_id, during tstzrange, status, customer_name, agent_name, created_at)`

Double booking is impossible at the database level:

```sql
constraint no_overlap exclude using gist (staff_id with =, during with &&) where (status = 'confirmed')
```

Two confirmed bookings for the same staff member can't overlap. `during` is half-open (`[start, end)`), so back-to-back bookings are fine. When the constraint fires, Postgres raises SQLSTATE `23P01`, and the `book` tool returns `slot_taken`. If two overlapping inserts arrive at the same moment, Postgres can also abort one with `40P01` (deadlock). The server retries that insert, which then fails cleanly with `23P01`.

**Access model:** the Next.js server connects as the database owner through `DATABASE_URL`. The browser never talks to the database. Row level security is enabled on every table with **no policies**, so Supabase's public API keys (`anon`, `authenticated`) can't read or write anything.

## Set up a Supabase project

### 1. Apply the migration, then the seed

**Option A: Supabase SQL editor.** In the Supabase dashboard, open **SQL Editor**. Paste the whole of `supabase/migrations/0001_skeleton.sql` and click **Run**. Then do the same with `supabase/seed.sql`.

**Option B: Supabase CLI.**

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

`db push` applies the migrations in `supabase/migrations/` that the project hasn't run yet. It doesn't load the seed. Load it from the SQL editor (Option A), or with `psql`:

```bash
psql "<direct or session connection string>" -f supabase/seed.sql
```

To check it worked, run `select * from services;` in the SQL editor. You should see three rows.

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

## What happens without `DATABASE_URL`

| Where | Behavior |
|---|---|
| Local (`pnpm dev`, tests) | Front Desk uses an in-memory copy of the seed data and logs one warning. Bookings are lost when the server restarts. Good for UI work without a database. |
| Vercel (the `VERCEL` env var is set) | Every Front Desk call fails with an `internal` error, and the function log says `DATABASE_URL is not set`. A deployment never serves fake data. |

The wiring lives in [`lib/server/frontdesk/deps.ts`](../lib/server/frontdesk/deps.ts).

## Running the Postgres tests

`pnpm test` uses the in-memory store. To also run the overlap and race tests against a real database, point `DATABASE_URL_TEST` at a **scratch** database with the migration and seed applied:

```bash
DATABASE_URL_TEST=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test
```

The tests insert bookings on dates in 2099 and delete them afterwards. Without `DATABASE_URL_TEST` they're skipped, and the test output says so.

A throwaway local database with Docker:

```bash
docker run -d --rm --name frontdesk-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:17-alpine
docker exec -i frontdesk-pg psql -U postgres < supabase/migrations/0001_skeleton.sql
docker exec -i frontdesk-pg psql -U postgres < supabase/seed.sql
```

## Changing the schema

Add a new numbered file, for example `supabase/migrations/0002_<what>.sql`. Never edit a migration that has already been applied to a shared database. If you change the demo data, update `SEED` in [`lib/server/frontdesk/memory-store.ts`](../lib/server/frontdesk/memory-store.ts) to match `supabase/seed.sql`.
