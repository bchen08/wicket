-- Front Desk, Ring 1a: shop rules and the booking lifecycle.
-- Apply once per database, after 0001_skeleton.sql, then (re)load supabase/seed.sql. See docs/database.md.
--
-- Adds: policies (one row per shop), blocked_times (holidays, time off), the full booking status
-- set with lifecycle timestamps, an events log (one row per state change), and idempotency keys
-- for the book and cancel tools. Same access model as 0001: RLS on, no policies.

-- ---- Shop policies ----
-- A shop without a row uses the defaults below (mirrored by DEFAULT_POLICIES in
-- lib/server/frontdesk/policies.ts). The ranges match POLICY_LIMITS there.
create table policies (
  shop_slug            text        primary key references shops (slug) on delete cascade,
  -- Minimum minutes between now and an appointment's start.
  lead_time_min        integer     not null default 120 check (lead_time_min between 0 and 10080),
  -- How many days ahead a service without a deposit can be booked.
  horizon_days         integer     not null default 30  check (horizon_days between 1 and 365),
  -- How many days ahead a service with a deposit can be booked (a card hold lasts about a week).
  deposit_horizon_days integer     not null default 6   check (deposit_horizon_days between 1 and 365),
  -- An agent cancelling at least this many hours ahead gets the deposit released; later, it's captured.
  cancel_window_hours  integer     not null default 24  check (cancel_window_hours between 0 and 720),
  -- The owner paused bookings: no availability, and book returns `paused`.
  paused               boolean     not null default false,
  phone                text        check (phone is null or char_length(phone) between 1 and 40),
  -- Plain-language rules, read to customers by agents. '' = not set.
  deposit_rule         text        not null default '' check (char_length(deposit_rule) <= 1000),
  late_cancel_rule     text        not null default '' check (char_length(late_cancel_rule) <= 1000),
  no_show_rule         text        not null default '' check (char_length(no_show_rule) <= 1000),
  updated_at           timestamptz not null default now()
);

-- ---- Blocked time: holidays and time off ----
create table blocked_times (
  id         uuid        primary key default gen_random_uuid(),
  staff_id   text        not null references staff (id) on delete cascade,
  -- Half-open, like bookings.during.
  during     tstzrange   not null,
  -- For the owner; never shown to agents.
  reason     text        not null default '' check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  constraint blocked_during_is_half_open check (
    not isempty(during) and lower_inc(during) and not upper_inc(during)
    and not lower_inf(during) and not upper_inf(during)
  )
);

create index blocked_times_staff_during on blocked_times using gist (staff_id, during);

-- ---- Booking lifecycle ----
-- Each multi-part ALTER TABLE below is one statement, so the table is never without its constraints.

alter table bookings
  add column cancelled_at  timestamptz,
  add column cancelled_by  text check (cancelled_by in ('agent', 'owner')),
  add column completed_at  timestamptz,
  add column no_show_at    timestamptz,
  -- The service's deposit when the booking was made, so later price changes don't rewrite history.
  add column deposit_cents integer;

update bookings b
set deposit_cents = s.deposit_cents
from services s
where s.shop_slug = b.shop_slug and s.id = b.service_id and b.deposit_cents is null;

alter table bookings
  alter column deposit_cents set default 0,
  alter column deposit_cents set not null,
  add constraint bookings_deposit_cents_check check (deposit_cents >= 0),
  -- awaiting_deposit and expired are produced from Ring 1c (deposits).
  drop constraint bookings_status_check,
  add constraint bookings_status_check check (
    status in ('awaiting_deposit', 'confirmed', 'cancelled', 'expired', 'completed', 'no_show')
  ),
  -- A booking waiting for its deposit holds the slot too.
  drop constraint no_overlap,
  add constraint no_overlap exclude using gist (staff_id with =, during with &&)
    where (status in ('awaiting_deposit', 'confirmed'));

-- ---- Events: one row per state change, written in the same transaction as the change ----
create table events (
  id         bigint      generated always as identity primary key,
  booking_id uuid        not null references bookings (id) on delete cascade,
  at         timestamptz not null default now(),
  actor      text        not null check (actor in ('agent', 'owner', 'system')),
  -- 'booked', 'cancelled', 'completed', 'no_show'; Ring 1b/1c add more.
  type       text        not null check (char_length(type) between 1 and 40),
  data       jsonb       not null default '{}'::jsonb
);

create index events_booking_at on events (booking_id, at, id);

-- ---- Idempotency keys for the book and cancel tools ----
-- The first successful call saves its response; a retry with the same key and arguments gets it back.
-- A key may be reused after 24 hours. TODO(ring-2): a job that deletes old keys.
create table idempotency_keys (
  key          text        not null check (char_length(key) between 8 and 128),
  tool         text        not null check (tool in ('book', 'cancel')),
  -- sha256 hex of the normalized arguments.
  request_hash text        not null,
  -- Null only inside the transaction that is running the call.
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (key, tool)
);

alter table policies         enable row level security;
alter table blocked_times    enable row level security;
alter table events           enable row level security;
alter table idempotency_keys enable row level security;
