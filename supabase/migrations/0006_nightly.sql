-- Front Desk: the nightly tidy-up's log.
-- Apply once per database, after 0005_deposits.sql. Seeds nothing. See docs/nightly.md and docs/database.md.
--
-- Once a day (Vercel Cron, 08:00 UTC) GET /api/jobs/nightly expires holds and unpaid deposits past their
-- deadlines and completes confirmed bookings that ended more than 3 hours ago, releasing their deposit holds.
-- Each run writes one row here with what it did; GET /api/status shows the newest as lastNightlyRun.
-- Additive only: one new table. Same access model as 0001: RLS on, no policies.

create table nightly_runs (
  id                bigint      generated always as identity primary key,
  -- When the run finished.
  ran_at            timestamptz not null default now(),
  -- Holds and unpaid deposits it expired.
  expired           integer     not null,
  -- Past confirmed bookings it marked completed.
  completed         integer     not null,
  -- Deposit holds it released (or unpaid payment pages it closed).
  deposits_released integer     not null,
  -- Bookings it couldn't finish (a Stripe failure, or an error); each is in the function log.
  failures          integer     not null
);

-- GET /api/status reads the newest run.
create index nightly_runs_ran_at on nightly_runs (ran_at desc, id desc);

alter table nightly_runs enable row level security;
