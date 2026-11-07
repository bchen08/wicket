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

### 1. Apply the migrations, then the seed

**Don't paste migrations into the SQL editor.** Supabase keeps a migration history in `supabase_migrations.schema_migrations` and runs only the files missing from it. A migration run by hand isn't recorded, so the next deploy runs it again and fails, for example with `relation "shops" already exists`. Apply migrations one of these two ways, which both record them:

**Option A: the GitHub integration (how this project is set up).** In the Supabase dashboard, **Branching → GitHub connection** links the repository, with `main` as the production branch. Every push to `main` applies the files in `supabase/migrations/` that aren't recorded yet. To run it without a new commit, open **Branches**, then the **⋯** menu on `main`, and choose **Resync branch**.

**Option B: Supabase CLI.**

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

`db push` applies and records the migrations the project hasn't run yet.

**Then load the seed by hand.** Neither option loads it on production; the integration's log says "Skipping seed data for protected branch". Run `supabase/seed.sql` once in the **SQL Editor**. It's safe to run again. You can also use `psql`:

```bash
psql "<direct or session connection string>" -f supabase/seed.sql
```

To check it worked, run these in the SQL editor:
- `select * from services;` should return three rows.
- `select version from supabase_migrations.schema_migrations;` should list every file in `supabase/migrations/`.

#### If a migration was applied by hand

Record it as applied, or the next deploy runs it again and fails. With the CLI, after `supabase link`:

```bash
supabase migration repair --status applied 0001
```

Or in the SQL editor:

```sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0001', 'skeleton', '{}');
```

The version is the number before the first `_` in the file name. The name is the rest, without `.sql`. Then re-run the failed deploy with **Resync branch** (Option A). Its log should say "All migrations are up to date."

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

`pnpm test` uses the in-memory store. To also run the overlap and race tests against a real database, point `DATABASE_URL_TEST` at a **scratch** database with the migrations and seed applied:

```bash
DATABASE_URL_TEST=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test
```

The tests insert bookings on dates in 2099 and delete them afterwards. Without `DATABASE_URL_TEST` they're skipped, and the test output says so.

A throwaway local database with Docker:

```bash
docker run -d --rm --name frontdesk-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:17-alpine
```

Then apply every migration in order, followed by the seed:

```bash
for f in supabase/migrations/*.sql supabase/seed.sql; do docker exec -i frontdesk-pg psql -U postgres -v ON_ERROR_STOP=1 < "$f" || break; done
```

## Changing the schema

Every schema change is a new migration file in an ordinary PR. The GitHub integration applies it to production when the PR merges to `main`.

1. **Add the next numbered file,** for example `supabase/migrations/0002_add_cancelled_at.sql`, containing only the change:

   ```sql
   alter table bookings add column cancelled_at timestamptz;
   ```

   Keep the `0001`, `0002`, … numbering. Supabase applies files in version order. `supabase migration new` names files with a timestamp (`20261108120000_x.sql`), which sorts after every numbered file, so a later `0003` would be refused as out of order.
2. **Never edit a migration that has been merged.** Production has already run it. To fix one, add another, such as `0003_fix_…`.
3. **Test it locally:** apply every migration and the seed to a throwaway Postgres, then run the Postgres tests. See [Running the Postgres tests](#running-the-postgres-tests).
4. **Open a PR.** The **Supabase Preview** check is skipped on PRs unless preview branches are enabled in Supabase, so nothing touches the database before merge.
5. **Merge.** On the push to `main`, the integration applies the new file to production and records it. To confirm, check that the **Supabase Preview** check on the merge commit is green, or look at **Branches → main → View Logs** in Supabase.

**Keep each migration compatible with the code that's already deployed.** On merge, Vercel deploys the new code while Supabase applies the migration, in no guaranteed order. Only add things the current code tolerates: new tables, nullable columns or columns with a default, constraints its writes already meet. Rename or drop something in a later PR, once no deployed code uses it.

**Never apply a migration in the SQL editor.** It bypasses the migration history; see [If a migration was applied by hand](#if-a-migration-was-applied-by-hand).

**Demo data:** the seed doesn't run on production. If you change `supabase/seed.sql`, run it once in the SQL editor after merging; it's safe to run again. Also update `SEED` in [`lib/server/frontdesk/memory-store.ts`](../lib/server/frontdesk/memory-store.ts) to match.

**Agents:** `supabase/**` isn't in Claude Code's default ownership area in AGENTS.md. An issue that needs a migration must authorize it, as #6 did.
