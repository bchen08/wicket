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

**Option B: Supabase CLI 3.x.**
- **Pass `--remote` every time.** In CLI 3, every command targets a *local* database unless you do. Pass the project's **Session pooler** connection string, with the password filled in. To find it, click **Connect**, open the **Direct** tab and choose **Session pooler**. The port is 5432. The transaction pooler is for the app, not the CLI.
- **Keep the password out of your shell history.** Put the string in a variable first: run `read -rs DB_URL`, paste the string and press Enter.

```bash
npx supabase@3 db push --remote="$DB_URL" --dry-run
```

```bash
npx supabase@3 db push --remote="$DB_URL"
```

`db push` applies and records the migrations the database hasn't run yet; `--dry-run` lists them first. `--include-seed` also loads the seed in the same run. The CLI writes a `supabase/.temp/` folder, which isn't git-ignored yet, so don't commit it.

**Then load the seed.** The integration never loads it on production; its log says "Skipping seed data for protected branch". Run `supabase/seed.sql` once in the **SQL Editor**, or add `--include-seed` to Option B's `db push`. Running it again is safe.

To check it worked, run these in the SQL editor:
- `select * from services;` should return three rows.
- `select version from supabase_migrations.schema_migrations;` should list every file in `supabase/migrations/`.

#### If a migration was applied by hand

Record it as applied, or the next deploy runs it again and fails. With CLI 3.x, using the Session pooler string as in Option B:

```bash
npx supabase@3 migration repair --status applied 0001 --remote="$DB_URL"
```

Without `--remote`, CLI 3 repairs a local database instead and changes nothing on Supabase.

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

**On Vercel:** go to **Project → Settings → Environment Variables**. `DATABASE_URL` has a different value per environment:
- For **Production**, the production project's string.
- For **Preview**, the Preview project's string. See [Production and Preview databases](#production-and-preview-databases).

The Add dialog selects Production only by default, so check the environment before saving. Redeploy afterwards, because environment variables apply to new deployments only.

## Production and Preview databases

Every PR gets a Vercel Preview deployment, and the verifier tests `book` there. If Preview used the production database, every test booking would land in the shop's real calendar. From Ring 1, it would also alert the real owner. So each environment has its own database:

| Vercel environment | `DATABASE_URL` points at | Migrations applied by |
|---|---|---|
| Production | the production Supabase project | the GitHub integration, on merge to `main` |
| Preview | a second, scratch Supabase project | you, with the CLI (below) |
| Local | whatever `.env.local` says, or unset for in-memory data | you |

**Tell them apart by the shop name.** In the Preview database, the shop is named **Hart's Barbers (preview)**. Before anything writes to a preview, check that `/api/shops/harts/services` on it shows "(preview)"; [VERIFIER.md](VERIFIER.md) requires this. If the name is plain, that preview is using the production database, and nothing may write to it.

### One-time setup

1. **Create a second Supabase project,** for example `emergent-preview`, in the same organization and region.
   - Don't connect it to GitHub; the integration stays on production.
   - A free project pauses after a week without use. Restore it from the dashboard before verifying.
2. **Apply the migrations and the seed** from an up-to-date `main` checkout, using the Preview project's **Session pooler** string:

   ```bash
   read -rs PREVIEW_DB_URL
   ```

   ```bash
   npx supabase@3 db push --remote="$PREVIEW_DB_URL" --include-seed
   ```

3. **Mark it as the preview database** by running this in the Preview project's SQL editor:

   ```sql
   update shops set name = 'Hart''s Barbers (preview)' where slug = 'harts';
   ```

4. **Split the variable in Vercel,** under **Settings → Environment Variables**:
   - Edit the existing `DATABASE_URL` so it applies to **Production** only.
   - Add another `DATABASE_URL`, type Secret, for **Preview** only. Its value is the Preview project's **Transaction pooler** string (port 6543), the same kind production uses.
5. **Redeploy a preview** and open `/api/shops/harts/services` on it. It should show "Hart's Barbers (preview)", while production still shows "Hart's Barbers".

### When a PR adds a migration

Before the verifier runs, push the PR's new migration to the Preview database from the PR branch:

```bash
npx supabase@3 db push --remote="$PREVIEW_DB_URL"
```

Production gets the migration from the integration when the PR merges.

### Resetting the Preview database

The Preview database is scratch, so reset it whenever it drifts from `main`: for example after a PR whose migration changed or was abandoned, or to clear test bookings. From an up-to-date `main` checkout:

```bash
npx supabase@3 db reset --remote="$PREVIEW_DB_URL"
```

The reset re-seeds, which brings back the plain shop name, so run the `update shops …` from step 3 again. If you forget, the verifier just won't book there, which is the safe direction.

> ⚠️ **`db reset` deletes every row and rebuilds the schema.** Before running it, check that `$PREVIEW_DB_URL` contains the Preview project's ref (`postgres.<ref>`). Never point it at production.

To clear only the bookings, run `delete from bookings;` in the **Preview** project's SQL editor.

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
4. **Open a PR, and push the migration to the Preview database** so the PR's preview runs against the new schema. See [When a PR adds a migration](#when-a-pr-adds-a-migration). The **Supabase Preview** check is skipped on PRs unless preview branches are enabled in Supabase, so production isn't touched before merge.
5. **Merge.** On the push to `main`, the integration applies the new file to production and records it. To confirm, check that the **Supabase Preview** check on the merge commit is green, or look at **Branches → main → View Logs** in Supabase.

**Keep each migration compatible with the code that's already deployed.** On merge, Vercel deploys the new code while Supabase applies the migration, in no guaranteed order. Only add things the current code tolerates: new tables, nullable columns or columns with a default, constraints its writes already meet. Rename or drop something in a later PR, once no deployed code uses it.

**Never apply a migration in the SQL editor.** It bypasses the migration history; see [If a migration was applied by hand](#if-a-migration-was-applied-by-hand).

**Demo data:** the seed doesn't run on production. If you change `supabase/seed.sql`, run it once in the SQL editor after merging; it's safe to run again. Also update `SEED` in [`lib/server/frontdesk/memory-store.ts`](../lib/server/frontdesk/memory-store.ts) to match.

**Agents:** `supabase/**` isn't in Claude Code's default ownership area in AGENTS.md. An issue that needs a migration must authorize it, as #6 did.
