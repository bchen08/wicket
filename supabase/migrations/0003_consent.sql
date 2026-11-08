-- Front Desk, Ring 1b: customer consent.
-- Apply once per database, after 0002_rules.sql. Seeds nothing. See docs/database.md.
--
-- book now holds the slot for 10 minutes (status 'awaiting_approval', until approve_by) and returns an
-- approval link. The person opens it, gets a 6-digit code on their phone and approves (→ confirmed,
-- with a verified customer) or declines (→ cancelled). A hold nobody answers is expired lazily.
-- Same access model as 0001: RLS on, no policies.
--
-- The approval token and the code are kept only as SHA-256 hashes. Phone numbers are stored as plain
-- E.164 strings (an MVP decision: no hashing of phone numbers).

-- ---- Customers: people who proved a phone number ----
create table customers (
  id           uuid        primary key default gen_random_uuid(),
  -- E.164, e.g. '+14015550123'. A returning customer is found by it.
  phone        text        not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- The name of the booking they last approved.
  display_name text        not null check (char_length(display_name) between 1 and 80),
  created_at   timestamptz not null default now()
);

-- ---- Bookings: the hold, the verified customer and the mandate ----
-- Each multi-part ALTER TABLE below is one statement, so the table is never without its constraints.
alter table bookings
  -- When the hold lapses. Set for every booking book creates; null for older rows.
  add column approve_by  timestamptz,
  -- Set when the person approves.
  add column customer_id uuid references customers (id) on delete set null,
  -- The person's limits as the agent sent them (priceCapCents, depositCapCents, window). Null if none.
  add column mandate     jsonb,
  add constraint bookings_mandate_is_object check (mandate is null or jsonb_typeof(mandate) = 'object'),
  drop constraint bookings_status_check,
  add constraint bookings_status_check check (
    status in ('awaiting_approval', 'awaiting_deposit', 'confirmed', 'cancelled', 'expired', 'completed', 'no_show')
  ),
  add constraint bookings_hold_has_deadline check (status <> 'awaiting_approval' or approve_by is not null),
  -- The person declining cancels the booking too.
  drop constraint bookings_cancelled_by_check,
  add constraint bookings_cancelled_by_check check (cancelled_by in ('agent', 'owner', 'customer')),
  -- A held slot can't be double-booked. A hold past approve_by is expired (status 'expired') before a
  -- new booking for that time is inserted, in the same transaction, so a stale hold never blocks one.
  drop constraint no_overlap,
  add constraint no_overlap exclude using gist (staff_id with =, during with &&)
    where (status in ('awaiting_approval', 'awaiting_deposit', 'confirmed'));

-- Lazy expiry looks for holds past their deadline.
create index bookings_holds on bookings (approve_by) where status = 'awaiting_approval';

-- ---- Events: the person approving or declining is the 'customer' actor ----
alter table events
  drop constraint events_actor_check,
  add constraint events_actor_check check (actor in ('agent', 'owner', 'customer', 'system'));

-- ---- Approvals: one per booking; the link's token is the credential ----
create table approvals (
  booking_id uuid        primary key references bookings (id) on delete cascade,
  -- SHA-256 of the token in the approval link, hex. The token itself is never stored.
  token_hash text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decision   text        check (decision in ('approved', 'declined')),
  constraint approvals_decided_together check ((decided_at is null) = (decision is null))
);

-- ---- One-time codes sent to a phone for an approval ----
-- Times here come from Front Desk's clock (FRONTDESK_NOW-aware), like approve_by, because the code's
-- expiry and the send limits are decided with it.
create table otp_challenges (
  -- Increasing: the latest code for a booking is the one with the highest id.
  id          bigint      generated always as identity primary key,
  booking_id  uuid        not null references bookings (id) on delete cascade,
  -- E.164, the number the code was sent to.
  phone       text        not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- SHA-256 of the 6-digit code, hex.
  code_hash   text        not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at  timestamptz not null,
  -- Approve attempts against this code. At most 5.
  attempts    integer     not null default 0 check (attempts between 0 and 5),
  -- Set when the code is used. A code works once.
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- The latest code for a booking, and the per-link send limit.
create index otp_challenges_booking on otp_challenges (booking_id, id);
-- The per-phone send limit (sends in the last hour).
create index otp_challenges_phone on otp_challenges (phone, created_at);

alter table customers      enable row level security;
alter table approvals      enable row level security;
alter table otp_challenges enable row level security;
