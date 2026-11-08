-- Front Desk, Ring 1b: customer consent.
-- Apply once per database, after 0002_rules.sql. Seeds nothing. See docs/database.md.
--
-- book now holds the slot for 10 minutes (status 'awaiting_approval', until approve_by) and returns an
-- approval link. The person opens it and approves (→ confirmed) or declines (→ cancelled); opening the
-- link and tapping Approve is the consent. A hold nobody answers is expired lazily.
-- TODO(ring-1c): a code texted to the person's phone comes back once real texting ships.
-- Same access model as 0001: RLS on, no policies.

-- ---- Bookings: the hold, the person's phone and the mandate ----
-- Each multi-part ALTER TABLE below is one statement, so the table is never without its constraints.
alter table bookings
  -- When the hold lapses. Set for every booking book creates; null for older rows.
  add column approve_by     timestamptz,
  -- The phone number the person gave when approving, E.164 (e.g. '+14015550123'). Optional; not checked.
  add column customer_phone text check (customer_phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- The person's limits as the agent sent them (priceCapCents, depositCapCents, window). Null if none.
  add column mandate        jsonb,
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
  -- new booking for that time is inserted, so a stale hold never blocks one.
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
  -- The token in the approval link, stored as it is, so every booking response can carry the link.
  token      text        not null unique,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decision   text        check (decision in ('approved', 'declined')),
  constraint approvals_decided_together check ((decided_at is null) = (decision is null))
);

alter table approvals enable row level security;

-- TODO: drop idempotency_keys in the next migration; unused since the MVP reset.
