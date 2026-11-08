# Database (Supabase Postgres)

Front Desk stores shops, services, staff hours, booking rules, blocked time, bookings and their history, people's approvals, and the alerts sent to owners, in Postgres, hosted on Supabase.

| File | What it is |
|---|---|
| [`supabase/migrations/0001_skeleton.sql`](../supabase/migrations/0001_skeleton.sql) | Ring 0: shops, services, staff, weekly hours, bookings, the no-double-booking constraint, row level security |
| [`supabase/migrations/0002_rules.sql`](../supabase/migrations/0002_rules.sql) | Ring 1a: shop policies, blocked times, the full booking lifecycle (statuses, timestamps, deposit snapshot), the events log |
| [`supabase/migrations/0003_consent.sql`](../supabase/migrations/0003_consent.sql) | Ring 1b: holds awaiting approval (`approve_by`, the mandate, the person's phone) and approval requests (one per booking, with the link's token) |
| [`supabase/migrations/0004_alerts.sql`](../supabase/migrations/0004_alerts.sql) | Owner alerts: `policies.owner_email` and the `alerts` table (one row per alert sent, logged or failed). Drops the unused `idempotency_keys`. |
| [`supabase/migrations/0005_deposits.sql`](../supabase/migrations/0005_deposits.sql) | Deposits through Stripe Checkout: the Checkout Session, its URL, the PaymentIntent, `pay_by`, `deposit_state` and the last refused capture or release on `bookings`. See [deposits.md](deposits.md#database-0005_depositssql). |
| [`supabase/migrations/0006_nightly.sql`](../supabase/migrations/0006_nightly.sql) | The nightly tidy-up's log: the `nightly_runs` table (one row per run, with its counts), which `/api/status` shows as `lastNightlyRun`. See [nightly.md](nightly.md#database-0006_nightlysql). |
| [`supabase/migrations/0007_texting.sql`](../supabase/migrations/0007_texting.sql) | Texting: `policies.owner_mobile`, the `text` alert channel, and the `owner_codes` table (the owner's texted sign-in codes). Additive only. See [texting.md](texting.md#database-0007_textingsql). |
| [`supabase/seed.sql`](../supabase/seed.sql) | Demo data: Hart's Barbers, its 3 services, staff member Dana, Tue–Sat hours, and Hart's policies. No bookings or blocked times. Needs 0002. Safe to run more than once. |

## Schema in one minute

- `shops (slug, name, timezone)`
- `services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)`
- `staff (id, shop_slug, name)`
- `weekly_hours (staff_id, weekday 1–7 ISO, opens, closes)`: several rows per day are allowed. Lunch is the gap between `09:00–12:00` and `12:30–17:00`.
- `bookings (id, shop_slug, service_id, staff_id, during tstzrange, status, customer_name, agent_name, created_at, cancelled_at, cancelled_by, completed_at, no_show_at, deposit_cents, approve_by, customer_phone, mandate)`
  - `status` is one of `awaiting_approval`, `awaiting_deposit`, `confirmed`, `cancelled`, `expired`, `completed`, `no_show`. `book` writes `awaiting_approval`; Ring 1c will write `awaiting_deposit`.
  - `approve_by`: when the hold lapses (booking time + 10 minutes). Required while `awaiting_approval`.
  - `customer_phone`: the person's phone number, plain E.164, or null: the one the agent gave with `book` (`customer_phone`; texted the approval link where texting is on), replaced by the one the person gave when approving, if any. Optional and not checked. `Booking.customer.phone` shows it.
  - `mandate`: the person's limits as the agent sent them (a JSON object), or null.
  - `cancelled_by` is `agent`, `owner` or `customer` (the person declined). Each transition stamps its own time column.
  - `deposit_cents` is a snapshot of the service's deposit when the booking was made, so a later price change doesn't rewrite history.
- `approvals (booking_id pk, token unique, created_at, decided_at, decision)`: one per booking. `token` is the token in the approval link, stored as it is, so every booking response can carry the link while the hold is on (`Booking.approval`). `decision` is `approved` or `declined`, set together with `decided_at`. `Booking.customer.approved` is `decision = 'approved'`.
- `policies (shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone, deposit_rule, late_cancel_rule, no_show_rule, owner_email, owner_mobile, updated_at)`: one row per shop. A shop without a row uses the column defaults (120 minutes, 30 days, 6 days, 24 hours, not paused, no phone, empty rules, no owner email or mobile). `owner_email` (at most 254 characters, or null) is where owner alerts are emailed; `owner_mobile` (E.164, or null) is where they're texted, and where the sign-in code goes, where texting is on. Agents never see either.
- `blocked_times (id, staff_id, during tstzrange, reason, created_at)`: holidays and time off. Half-open, like bookings. The owner sees `reason`; agents never do.
- `events (id, booking_id, at, actor, type, data jsonb)`: one row per booking state change (`booked`, `approved`, `declined`, `expired`, `cancelled`, `completed`, `no_show`), written in the same transaction as the change. `actor` is `agent`, `owner`, `customer` or `system`.
- `alerts (id, shop_slug, booking_id, kind, channel, recipient, status, error, created_at)`: one row per owner alert, whatever happened to it. `kind` is `booking_confirmed` or `booking_cancelled`; `channel` is `email` (to `recipient`), `text` (to `recipient`, the owner's mobile; as well as the email or log line) or `log` (`recipient` null); `status` is `sent`, `logged` or `failed` (with `error`). `id` increases. Deleting a booking deletes its alerts. The owner reads the newest 50 with `GET /api/shops/[shop]/alerts` ([frontdesk-api.md](frontdesk-api.md#owner-alerts)).
- `owner_codes (id, shop_slug, code, sent_to, expires_at, used_at, created_at)`: 6-digit sign-in codes texted to the owner ([texting.md](texting.md#3-owner-sign-in-by-texted-code)). Valid until `expires_at` (10 minutes), once: `used_at` is set when one signs in. Stored as they are.
- `idempotency_keys`: from 0002, unused since the MVP reset, dropped by 0004.

Double booking is impossible at the database level:

```sql
constraint no_overlap exclude using gist (staff_id with =, during with &&)
  where (status in ('awaiting_approval', 'awaiting_deposit', 'confirmed'))
```

Two bookings that hold time (`awaiting_approval`, `awaiting_deposit` or `confirmed`) for the same staff member can't overlap, so a held slot can't be double-booked. A hold past `approve_by` would still count, so `book` first marks such holds `expired` in the same transaction (lazy expiry; see [frontdesk-api.md](frontdesk-api.md#lazy-expiry)): a stale hold never blocks a new booking. Cancelled, expired, completed and no-show bookings free their time. `during` is half-open (`[start, end)`), so back-to-back bookings are fine. When the constraint fires, Postgres raises SQLSTATE `23P01`. The `book` tool then reads busy time again and, if another staff member is free at that exact start, tries once more with them; otherwise it returns `slot_taken`. If two overlapping inserts arrive at the same moment, Postgres can also abort one with `40P01` (deadlock). The server retries that insert, which then fails cleanly with `23P01`.

Booking state changes are conditional: `UPDATE bookings … WHERE id = … AND status = <expected>`, with the event inserted in the same statement. Of two concurrent changes to one booking, only one matches; the other writes nothing.

**Access model:** the Next.js server connects as the database owner through `DATABASE_URL`. The browser never talks to the database. Row level security is enabled on every table with **no policies** (one `alter table … enable row level security;` per table), so Supabase's public API keys (`anon`, `authenticated`) can't read or write anything.

### Database time and `FRONTDESK_NOW`

`created_at` (bookings and alerts), `events.at`, `cancelled_at`, `completed_at` and `no_show_at` are set by the database with `now()` (the start of the transaction). `FRONTDESK_NOW` freezes only Front Desk's own clock, which drives the booking rules (see [frontdesk-api.md](frontdesk-api.md)). So with Postgres:
- `createdAt`, event times and the lifecycle timestamps show real time, even when the app clock is frozen.

The in-memory store (no `DATABASE_URL`) stamps all of these with the app clock instead, so with `FRONTDESK_NOW` set they show the frozen instant.

The consent times are the exception: `bookings.approve_by` and `approvals.decided_at` come from Front Desk's clock in both stores, because the hold is decided with it. So with `FRONTDESK_NOW` frozen a hold never lapses; restart with a later `FRONTDESK_NOW` to see it expire.

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

**Then load the seed,** after every migration has run: it needs 0002, because it also inserts Hart's policies. The integration never loads it on production; its log says "Skipping seed data for protected branch". Run `supabase/seed.sql` once in the **SQL Editor**, or add `--include-seed` to Option B's `db push`. Running it again is safe.

To check it worked, run these in the SQL editor:
- `select * from services;` should return three rows, and `select * from policies;` one row, for `harts`.
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

### Ring 1a: applying 0002 to a database that already has 0001

`0002_rules.sql` is applied like any other migration (never in the SQL editor):

1. **Preview database, before the verifier runs on the Ring 1a PR:** from the PR branch, push it, then re-run the seed so Hart's gets its policies:

   ```bash
   npx supabase@3 db push --remote="$PREVIEW_DB_URL" --include-seed
   ```

   Re-seeding is safe: every insert is `on conflict do nothing`, so it doesn't overwrite the "(preview)" shop name or any policies an owner changed.
2. **Production:** the GitHub integration applies 0002 when the PR merges. Then run `supabase/seed.sql` once in the production **SQL Editor** to insert Hart's policies. Until then, Hart's uses the column defaults (no phone, empty rule texts).
3. **Check** with `select * from policies;` (one row, for `harts`) and `select version from supabase_migrations.schema_migrations;` (lists `0002`).

What 0002 does to existing data:
- Existing bookings keep their status (`confirmed` and `cancelled` are still valid). Each gets `deposit_cents` from its service's current deposit.
- `services` gets a check that `deposit_cents <= price_cents`. It's validated against existing rows, so 0002 fails if a service already has a deposit larger than its price; fix that row first.
- The new tables start empty, so old bookings have no events.

It's additive, so it's compatible with the Ring 0 code already deployed: new tables, nullable columns, a `deposit_cents` column with a default, and widened checks that Ring 0's writes already meet. If the new code is deployed before the integration has applied 0002, Front Desk calls fail with `internal` until it has.

### Ring 1b: applying 0003

`0003_consent.sql` is applied like any other migration (never in the SQL editor). It seeds nothing, so there's no seed to re-run. It's additive: it doesn't drop anything.

1. **Preview database, before the verifier runs on the MVP-reset PR:** the Preview database ran an earlier version of 0003 (approval tokens kept as a hash; possibly phone-code tables). It's scratch, so reset it from the PR branch, then mark it as the preview again:

   ```bash
   npx supabase@3 db reset --remote="$PREVIEW_DB_URL"
   ```

   ```sql
   update shops set name = 'Hart''s Barbers (preview)' where slug = 'harts';
   ```

   See [Resetting the Preview database](#resetting-the-preview-database) for the checks before a reset.
2. **Production:** the GitHub integration applies 0003 when the PR merges. Production never ran an earlier 0003.
3. **Check** with `select version from supabase_migrations.schema_migrations;` (lists `0003`) and `select booking_id, token, decision from approvals limit 1;`.

What 0003 does to existing data:
- Existing bookings keep their status; `approve_by`, `customer_phone` and `mandate` are null. They show `customer.approved: false`: nobody approved them through a link.
- The `no_overlap` constraint is rebuilt to cover `awaiting_approval` too. No existing row has that status, so it rebuilds without conflicts.
- `approvals` starts empty. 0003 drops nothing.

It's compatible with the Ring 1a code already deployed: new columns are nullable, the widened checks accept what Ring 1a writes, and the 0002 table Ring 1a's `book` and `cancel` write to is still there while the new code rolls out. If the new code is deployed before the integration has applied 0003, `book`, `get_booking` and the approval routes fail with `internal` until it has.

### Owner alerts: applying 0004

`0004_alerts.sql` is applied like any other migration (never in the SQL editor). It seeds nothing.

1. **Preview database:** the Preview database workflow rebuilds it from the PR's branch, because the PR changes `supabase/`. Check `/api/status` on the preview: `"schema": "current"`.
2. **Production:** the GitHub integration applies 0004 when the PR merges.
3. **Check** with `select version from supabase_migrations.schema_migrations;` (lists `0004`) and `select owner_email from policies;`.

What 0004 does to existing data:
- `policies.owner_email` is null for every shop, so alerts are logged until the owner sets an address (`PUT /api/shops/harts/policies` with `{"ownerEmail": "…"}`).
- `alerts` starts empty: bookings confirmed or cancelled before 0004 have no alerts.
- It drops `idempotency_keys`. Nothing deployed reads or writes it since the MVP reset.

The code already deployed tolerates it: it never reads `owner_email` or `alerts`. If the new code is deployed before the integration has applied 0004, reading a shop's policies fails, so most Front Desk calls fail with `internal` until it has; `/api/status` names what's missing.

### The nightly tidy-up: applying 0006

`0006_nightly.sql` is applied like any other migration (never in the SQL editor). It adds one table, `nightly_runs`, with RLS on and no policies, and seeds nothing. See [nightly.md](nightly.md).

1. **Preview database:** the Preview database workflow rebuilds it from the PR's branch, because the PR changes `supabase/`. Check `/api/status` on the preview: `"schema": "current"` and `"lastNightlyRun": null` until something calls `/api/jobs/nightly`.
2. **Production:** the GitHub integration applies 0006 when the PR merges. The first cron run (08:00 UTC) writes the first row.
3. **Check** with `select version from supabase_migrations.schema_migrations;` (lists `0006`) and `select * from nightly_runs order by ran_at desc limit 1;`.

It changes no existing data, and the code already deployed never reads `nightly_runs`. If the new code is deployed before the integration has applied 0006, `/api/status` says `outdated` (missing `nightly_runs`) and `lastNightlyRun: null`, and `/api/jobs/nightly` does its work but answers `internal` when it can't record the run.

### Texting: applying 0007

`0007_texting.sql` is applied like any other migration. It seeds nothing, and it is additive only:
- `policies.owner_mobile` is null for every shop, so nothing is texted to the owner until it's set (`PUT /api/shops/harts/policies` with `{"ownerMobile": "+1…"}`).
- The `alerts.channel` check is replaced by one that also accepts `text`. Existing rows all pass it.
- `owner_codes` starts empty.

The code already deployed tolerates it, because it never reads the new column or table. If the new code is deployed before 0007 is applied, reading a shop's policies fails (`owner_mobile`), so most Front Desk calls fail with `internal` until it is. `/api/status` names what's missing.

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

### 4. Set `OWNER_API_TOKEN`

`OWNER_API_TOKEN` is the shop's access code. It protects the owner routes: the bookings list (which `/console` shows), policies, hours, blocked time, adding and changing services, the booking actions (cancel, complete, no-show) and a booking's history. Scripts send it as `Authorization: Bearer <OWNER_API_TOKEN>`; the owner types it once at `/console/unlock`, which sets the `fd_owner` cookie. See [frontdesk-api.md](frontdesk-api.md#owner-routes). The MCP tools, the approval link and the public `GET` services route don't use it.

Generate a random one, for example:

```bash
openssl rand -hex 32
```

**Locally:** put it in `.env.local`, next to `DATABASE_URL`.

```bash
OWNER_API_TOKEN=<64 hex characters>
```

**On Vercel:** under **Settings → Environment Variables**, add `OWNER_API_TOKEN` (type Secret) for **Production** and for **Preview**, ideally with a different value for each, then redeploy. The Add dialog selects Production only by default, so check the environments before saving.

- If it's unset or empty, every owner request is **401** with next_action "Owner access isn't set up: set OWNER_API_TOKEN in Vercel and redeploy." A missing or wrong token in a request is **401** too.
- **Never commit it.** Anyone holding it can read the bookings (with phone numbers), change the shop's rules and act on its bookings. To rotate it, change the value in Vercel and redeploy; that also ends every `fd_owner` session.
- It's a stopgap: `TODO(ring-2)`: owner sign-in replaces the token.

### 5. Set `RESEND_API_KEY` (Production only)

With it, [owner alerts](frontdesk-api.md#owner-alerts) are emailed through Resend to the shop's `ownerEmail`; without it, they're written to the function log. Set it for **Production only**: previews log their alerts, so test bookings never email the real owner.

1. Create a Resend account **with the email address the owner's alerts should go to**. Alerts are sent from Resend's shared `onboarding@resend.dev`, and with that sender Resend only delivers to the account's own address. `TODO(ring-3)`: send from the shop's own domain.
2. In Resend, create an API key with **Sending access**.
3. In Vercel, **Settings → Environment Variables**, add `RESEND_API_KEY` (type Secret) for **Production** only, then redeploy. `/api/status` on production then shows `"alerts": "email"`.
4. Set the shop's `ownerEmail` to that same address: `PUT /api/shops/harts/policies` with `{"ownerEmail": "…"}` (see [frontdesk-api.md](frontdesk-api.md#policies)).

A failed send (a wrong key, an address Resend won't deliver to) never affects the booking. It shows up in `GET /api/shops/harts/alerts` as `"status": "failed"` with Resend's message.

### 6. Texting (optional, Production only)

Set **one** sender's variables for **Production** only (previews then never text anyone): Photon's `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` and `PHOTON_LINE`, or Twilio's `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`. Redeploy; `/api/status` shows `"texting": "photon"` or `"twilio"`. Then set Hart's `ownerMobile` (`PUT /api/shops/harts/policies` with `{"ownerMobile": "+1…"}`) for owner alerts and sign-in codes by text. See [texting.md](texting.md).

## Environment variables

| Variable | Where | Required | What |
|---|---|---|---|
| `DATABASE_URL` | Vercel (per environment), local | On Vercel | The Supabase transaction pooler string (port 6543). Unset locally: in-memory data. |
| `OWNER_API_TOKEN` | Vercel (per environment), local | For the owner routes and `/console` | The shop's access code: the owner routes' Bearer token and the `fd_owner` cookie's value. |
| `RESEND_API_KEY` | Vercel, **Production only** | No | Email owner alerts through Resend to the shop's `ownerEmail`. Unset (previews, local): alerts are logged instead. |
| `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_LINE` | Vercel, **Production only** | No | Texting by iMessage through Photon ([texting.md](texting.md#photon-imessage)). All three set: `/api/status` `"texting": "photon"`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Vercel, **Production only** | No | Texting by SMS through Twilio, when Photon isn't set ([texting.md](texting.md#twilio-sms)). Neither sender set: texting is off, and everything works as before. |
| `STRIPE_SECRET_KEY` | Vercel (Preview and Production), local | No | A Stripe **test** secret key (`sk_test_…`): deposits are held through Stripe Checkout. Unset: deposits are off and bookings confirm without one. See [deposits.md](deposits.md#setup). |
| `FRONTDESK_NOW` | Local, demos | No | Freeze Front Desk's clock at an RFC 3339 instant. |
| `DATABASE_URL_TEST` | Local, CI if wanted | No | A scratch Postgres for the Postgres tests. |
| `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA` | Set by Vercel | — | `/api/status` reports them as `environment` and `commit`. Unset locally: `development`, `null`. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Set by Vercel (Protection Bypass for Automation); a verifier's shell | — | The secret `pnpm smoke --bypass` sends past Vercel Authentication. The app doesn't read it. |
| `PREVIEW_DB_URL` | GitHub Actions secret | For the Preview database workflow | The Preview project's Session pooler string (port 5432). |
| `SUPABASE_ACCESS_TOKEN` | GitHub Actions secret | No | Only if the Supabase CLI ever asks for one in the Preview database workflow. |

## Production and Preview databases

Every PR gets a Vercel Preview deployment, and the verifier tests `book` there. If Preview used the production database, every test booking would land in the shop's real calendar. From Ring 1, it would also alert the real owner. So each environment has its own database:

| Vercel environment | `DATABASE_URL` points at | Migrations applied by |
|---|---|---|
| Production | the production Supabase project | the GitHub integration, on merge to `main` |
| Preview | a second, scratch Supabase project (`emergent-preview`, ref `qaaaxyzvyeigzjqltrlb`) | the **Preview database** workflow, on every PR that changes `supabase/` (below) |
| Local | whatever `.env.local` says, or unset for in-memory data | you |

**Tell them apart by the shop name.** In the Preview database, the shop is named **Hart's Barbers (preview)**. `/api/status` reads it: `database.writesAllowed` is `true` only on a non-production deployment whose shop name ends in "(preview)" (or with in-memory data), and a preview on any other database reports `not_ready`, because it might be production's. Nothing may write to a deployment whose `writesAllowed` is `false`; [VERIFIER.md](VERIFIER.md) and `pnpm smoke` both check it.

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
5. **Redeploy a preview** and open `/api/status` on it. It should show `"shopName": "Hart's Barbers (preview)"` and `"writesAllowed": true`, while production shows "Hart's Barbers" and `false`.
6. **Give GitHub the Preview database,** so the workflow below can rebuild it: under the repository's **Settings → Secrets and variables → Actions**, add the secret `PREVIEW_DB_URL`, the Preview project's **Session pooler** string (port 5432; the one the CLI uses).

### The Preview database keeps itself current

[`.github/workflows/preview-db.yml`](../.github/workflows/preview-db.yml) (**Actions → Preview database**) rebuilds the Preview database from a PR's branch:

- **When:** a PR that changes anything under `supabase/` is opened or gets a new push. To run it by hand (for example after a run for another PR, or to clear test bookings), open **Actions → Preview database → Run workflow** and pick the branch.
- **What:** `npx supabase@3 db reset --remote="$PREVIEW_DB_URL" --yes` (every migration on that branch, then `supabase/seed.sql`), then `update shops set name = 'Hart''s Barbers (preview)' where slug = 'harts';`, which it checks.
- **Only ever the Preview database:** before the reset it stops with an error unless `PREVIEW_DB_URL` contains `postgres.qaaaxyzvyeigzjqltrlb`, the Preview project's ref (a plain constant in the workflow, not a secret).
- **No access token:** CLI 3 resets a database given by connection string without one. If Supabase ever asks for one, add a `SUPABASE_ACCESS_TOKEN` Actions secret; the workflow passes it on when it exists.

**One shared Preview database: the most recent PR wins.** Every preview deployment uses the same Preview database, and the workflow's concurrency group `preview-db` runs one rebuild at a time, so the schema is whichever branch ran last. When PR A adds a migration and PR B then rebuilds from a branch without it, A's preview is on the older schema again: its `/api/status` says `not_ready` (`schema: "outdated"`, naming what's missing), and `pnpm smoke` says BLOCKED instead of failing. Re-run the workflow on A's branch before verifying A. A rebuild also deletes every booking in the Preview database, including test bookings.

Production gets the migration from the integration when the PR merges.

### Resetting the Preview database

The Preview database is scratch, so rebuild it whenever it drifts: run **Actions → Preview database → Run workflow** on the branch you want (`main`, or a PR's branch). To clear only the bookings, run `delete from bookings;` in the **Preview** project's SQL editor.

If GitHub Actions isn't available, the same thing by hand, from an up-to-date checkout:

```bash
npx supabase@3 db reset --remote="$PREVIEW_DB_URL" --yes
```

```sql
update shops set name = 'Hart''s Barbers (preview)' where slug = 'harts';
```

The reset re-seeds, which brings back the plain shop name, so the `update shops …` must follow. If you forget, `/api/status` on previews says `not_ready` and nothing books there, which is the safe direction.

> ⚠️ **`db reset` deletes every row and rebuilds the schema.** Before running it by hand, check that `$PREVIEW_DB_URL` contains the Preview project's ref (`postgres.qaaaxyzvyeigzjqltrlb`). Never point it at production.

## What happens without `DATABASE_URL`

| Where | Behavior |
|---|---|
| Local (`pnpm dev`, tests) | Front Desk uses an in-memory copy of the seed data (including Hart's policies) and logs one warning. Bookings, events and owner changes are lost when the server restarts. Good for UI work without a database. |
| Vercel (the `VERCEL` env var is set) | Every Front Desk call fails with an `internal` error, and the function log says `DATABASE_URL is not set`. A deployment never serves fake data. `/api/status` says `not_ready` and which environment's variable to set. |

The wiring lives in [`lib/server/frontdesk/deps.ts`](../lib/server/frontdesk/deps.ts).

## Running the Postgres tests

`pnpm test` uses the in-memory store. To also run the tests against a real database, point `DATABASE_URL_TEST` at a **scratch** database with every migration in `supabase/migrations/` and the seed applied:

```bash
DATABASE_URL_TEST=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test
```

These files use it:

| File | What it covers |
|---|---|
| [`lib/server/frontdesk/status-pg.test.ts`](../lib/server/frontdesk/status-pg.test.ts) | `/api/status` on a real database: every column in `REQUIRED_SCHEMA` exists once every migration has run, the shop's name, and the schema reported `current`. Read-only. |
| [`lib/server/frontdesk/postgres-store.test.ts`](../lib/server/frontdesk/postgres-store.test.ts) | The Postgres store itself: overlaps and races (`23P01`, `40P01`), the deposit snapshot and `booked` event, conditional transitions and their timestamps, busy time including blocked time, lazy expiry, approval answers, owner alerts (text alerts included), the owner's texted sign-in codes, and the owner writes (policies with `owner_email` and `owner_mobile`, services, hours, blocks). |
| [`lib/server/frontdesk/flow-pg.test.ts`](../lib/server/frontdesk/flow-pg.test.ts) | The lifecycle flow through the service layer, the code the MCP tools and owner routes call: book (and the same slot again → slot_taken), approve, cancel (released, captured, none), cancel after the start, an owner no-show, and concurrent books and cancels. |
| [`lib/server/consent/consent-pg.test.ts`](../lib/server/consent/consent-pg.test.ts) | The consent flow on Postgres: approve with and without a phone (the token and the phone stored as they are), decline, and lazy expiry (a stale hold never blocks a new booking; exactly one `expired` event under concurrency). |
| [`lib/server/deposits/deposits-pg.test.ts`](../lib/server/deposits/deposits-pg.test.ts) | Deposits on Postgres (0005's columns) with a stubbed Stripe: approve, pay, capture, a refused release, an unpaid deposit expiring. |
| [`lib/server/frontdesk/nightly-pg.test.ts`](../lib/server/frontdesk/nightly-pg.test.ts) | The nightly tidy-up on Postgres for a throwaway shop only (`tidyShop`): a lapsed hold and an unpaid deposit expired, a past booking completed with its deposit released, a future one left alone, a second run changing nothing; `listBookings` by status; `nightly_runs` written and read. |

They only touch rows of their own and delete them afterwards: bookings in 2099 (their approvals and events cascade), and a throwaway shop for the lifecycle, consent and owner-write tests. Hart's seeded rows are read, never changed. Without `DATABASE_URL_TEST` they're skipped, and the test output says so.

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

1. **Add the next numbered file,** for example `supabase/migrations/0004_add_staff_color.sql`, containing only the change:

   ```sql
   alter table staff add column color text;
   ```

   Keep the `0001`, `0002`, … numbering. Supabase applies files in version order. `supabase migration new` names files with a timestamp (`20261108120000_x.sql`), which sorts after every numbered file, so a later `0004` would be refused as out of order.
2. **Never edit a migration that has been merged.** Production has already run it. To fix one, add another, such as `0004_fix_…`.
3. **When the code reads or writes the new column, add it to `REQUIRED_SCHEMA`** in [`lib/server/frontdesk/schema.ts`](../lib/server/frontdesk/schema.ts), in the same PR. `/api/status` calls a database `current` only if every column listed there exists, and `schema.test.ts` fails when `postgres-store.ts` uses a column the list lacks (or the list names one nothing uses).
4. **Test it locally:** apply every migration and the seed to a throwaway Postgres, then run the Postgres tests. See [Running the Postgres tests](#running-the-postgres-tests).
5. **Open a PR.** The Preview database workflow rebuilds the Preview database from your branch, so the PR's preview runs against the new schema; check that `/api/status` on the preview says `"schema": "current"`. See [The Preview database keeps itself current](#the-preview-database-keeps-itself-current). The **Supabase Preview** check is skipped on PRs unless preview branches are enabled in Supabase, so production isn't touched before merge.
6. **Merge.** On the push to `main`, the integration applies the new file to production and records it. To confirm, check that the **Supabase Preview** check on the merge commit is green, or look at **Branches → main → View Logs** in Supabase.

**Keep each migration compatible with the code that's already deployed.** On merge, Vercel deploys the new code while Supabase applies the migration, in no guaranteed order. Only add things the current code tolerates: new tables, nullable columns or columns with a default, constraints its writes already meet. Rename or drop something in a later PR, once no deployed code uses it.

**Never apply a migration in the SQL editor.** It bypasses the migration history; see [If a migration was applied by hand](#if-a-migration-was-applied-by-hand).

**Demo data:** the seed doesn't run on production. If you change `supabase/seed.sql`, run it once in the SQL editor after merging; it's safe to run again. Also update `SEED` in [`lib/server/frontdesk/memory-store.ts`](../lib/server/frontdesk/memory-store.ts) to match. If you change a policy default or range, update `DEFAULT_POLICIES` and `POLICY_LIMITS` in [`lib/server/frontdesk/policies.ts`](../lib/server/frontdesk/policies.ts) to match the `policies` table.

**Agents:** `supabase/**` isn't in Claude Code's default ownership area in AGENTS.md. An issue that needs a migration must authorize it, as #6, #8 and #15 did.
