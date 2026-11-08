-- Front Desk: connector sign-in verifies the phone with a texted code, where texting is on.
-- Apply once per database, after the migrations before it. Seeds nothing. See docs/connector-signin.md.
--
-- /signin texts a 6-digit code to the number the person typed and waits here for them to enter it. The name
-- waits with it: the customer is only created or renamed once the code is right.
-- Stored as they are (MVP: no hashing, no attempt limits). Additive only: one new table, RLS on, no policies.

create table signin_codes (
  id         uuid        primary key default gen_random_uuid(),
  shop_slug  text        not null references shops (slug),
  code       text        not null check (code ~ '^[0-9]{6}$'),
  -- The number it was texted to, E.164: the number the person signs in with.
  phone      text        not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name       text        not null check (char_length(name) between 1 and 80),
  expires_at timestamptz not null,
  -- When it was entered; null while unused. A code works once.
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

alter table signin_codes enable row level security;
