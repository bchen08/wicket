-- Front Desk: the owner hears about every booking.
-- Apply once per database, after 0003_consent.sql. Seeds nothing. See docs/database.md.
--
-- When a booking is confirmed (the person approved) or cancelled (the agent cancelled it, or the person
-- declined), Front Desk alerts the shop owner: an email to policies.owner_email when RESEND_API_KEY is set,
-- otherwise a log line. Every alert, sent or not, is one row in alerts, which the owner route
-- GET /api/shops/[shop]/alerts lists. Same access model as 0001: RLS on, no policies.

-- ---- Policies: where the owner's alerts go ----
alter table policies
  -- The owner's email address for booking alerts. Null: alerts are logged instead of emailed.
  add column owner_email text check (owner_email is null or char_length(owner_email) <= 254);

-- ---- Alerts: one row per alert, whatever happened to it ----
create table alerts (
  id         bigint      generated always as identity primary key,
  shop_slug  text        not null references shops (slug) on delete cascade,
  booking_id uuid        not null references bookings (id) on delete cascade,
  kind       text        not null check (kind in ('booking_confirmed', 'booking_cancelled')),
  -- 'email': sent through Resend to recipient. 'log': written to the function log.
  channel    text        not null check (channel in ('email', 'log')),
  -- The email address it went to; null for a log line.
  recipient  text,
  status     text        not null check (status in ('sent', 'logged', 'failed')),
  -- Why it failed; null unless status is 'failed'.
  error      text,
  created_at timestamptz not null default now()
);

-- The owner's list: a shop's newest alerts first.
create index alerts_shop_created on alerts (shop_slug, created_at desc, id desc);

alter table alerts enable row level security;

-- ---- Unused since the MVP reset (the TODO in 0003) ----
drop table if exists idempotency_keys;
