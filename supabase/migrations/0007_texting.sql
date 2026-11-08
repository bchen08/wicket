-- Front Desk: texting. Apply once per database, after the previous migration. Seeds nothing.
-- See docs/texting.md and docs/database.md.
--
-- Where a text sender is configured (Photon iMessage or Twilio SMS), Front Desk texts the approval link to
-- the person (bookings.customer_phone, now also set by book), texts every owner alert to policies.owner_mobile
-- (one more alerts row, channel 'text'), and texts the owner a 6-digit sign-in code (owner_codes).
-- Additive only: one nullable column, one wider check, one new table. Same access model as 0001: RLS on,
-- no policies.

-- ---- Policies: the owner's mobile ----
alter table policies
  -- The owner's mobile number, E.164, for owner alerts and sign-in codes by text. Null: nothing is texted to the owner.
  add column owner_mobile text check (owner_mobile is null or owner_mobile ~ '^\+[1-9][0-9]{7,14}$');

-- ---- Alerts: a text is one more channel ----
alter table alerts
  drop constraint alerts_channel_check,
  -- 'text': texted to recipient (the owner's mobile), as well as the email or log line.
  add constraint alerts_channel_check check (channel in ('email', 'log', 'text'));

-- ---- Owner sign-in codes: texted to policies.owner_mobile, valid 10 minutes, single use ----
-- Stored as they are (MVP: no hashing, no attempt limits; see docs/texting.md).
create table owner_codes (
  id         bigint      generated always as identity primary key,
  shop_slug  text        not null references shops (slug) on delete cascade,
  code       text        not null check (code ~ '^[0-9]{6}$'),
  -- The mobile number it was texted to (E.164).
  sent_to    text        not null,
  expires_at timestamptz not null,
  -- When it was used to sign in; null while unused. A code works once.
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

alter table owner_codes enable row level security;
