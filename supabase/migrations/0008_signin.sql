-- Front Desk: connector sign-in. People connect Front Desk to Claude or ChatGPT once and sign in with
-- their name and mobile number, so their agent books as them and can list and manage their bookings.
-- Apply once per database, after 0007. Seeds nothing. See docs/connector-signin.md and docs/database.md.
--
-- Front Desk is the OAuth 2.1 authorization server for its own MCP endpoint (/api/mcp). Tokens, codes and
-- client records are stored as they are (MVP: no hashing). Every row carries its shop, so more than one
-- shop can sign people in later; today there is one issuer, for harts.
-- TODO(ring-2): verify the phone with a texted code once texting lands.
-- Additive only: new tables and one nullable column. Same access model as 0001: RLS on, no policies.

-- ---- Customers: one per (shop, mobile number) ----
create table customers (
  id         uuid        primary key default gen_random_uuid(),
  shop_slug  text        not null references shops (slug),
  -- The name the person gave when signing in (the latest one). Bookings use it when the agent sends none.
  name       text        not null check (char_length(name) between 1 and 80),
  -- E.164, e.g. '+14015550123'. Not verified yet (see the TODO above).
  phone      text        not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_slug, phone)
);

-- ---- Bookings made by a signed-in agent belong to the customer ----
alter table bookings add column customer_id uuid references customers (id);

-- list_my_bookings: one customer's bookings, by time.
create index bookings_customer on bookings (customer_id, lower(during)) where customer_id is not null;

-- ---- OAuth clients: Client ID Metadata Documents (cached) and dynamically registered clients ----
create table oauth_clients (
  shop_slug     text        not null references shops (slug),
  -- A CIMD client's id is the HTTPS URL of its metadata document; a registered client's is ours.
  client_id     text        not null,
  kind          text        not null check (kind in ('cimd', 'registered')),
  client_name   text,
  -- JSON array of the redirect URIs the client declared.
  redirect_uris jsonb       not null check (jsonb_typeof(redirect_uris) = 'array'),
  -- When the metadata document was last fetched (CIMD) or the client registered.
  fetched_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  primary key (shop_slug, client_id)
);

-- ---- Authorization codes: one sign-in, exchanged once for tokens ----
create table oauth_codes (
  code           text        primary key,
  shop_slug      text        not null references shops (slug),
  client_id      text        not null,
  customer_id    uuid        not null references customers (id) on delete cascade,
  redirect_uri   text        not null,
  -- PKCE: base64url(SHA-256(code_verifier)). Only S256 is accepted.
  code_challenge text        not null,
  scope          text        not null,
  -- The RFC 8707 resource the client asked for (the MCP endpoint), as given; null if none.
  resource       text,
  expires_at     timestamptz not null,
  -- Set when the code is exchanged; a used code is refused.
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- ---- Tokens: access tokens (1 hour) and refresh tokens (30 days) ----
create table oauth_tokens (
  token       text        primary key,
  kind        text        not null check (kind in ('access', 'refresh')),
  shop_slug   text        not null references shops (slug),
  client_id   text        not null,
  customer_id uuid        not null references customers (id) on delete cascade,
  scope       text        not null,
  resource    text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

alter table customers     enable row level security;
alter table oauth_clients enable row level security;
alter table oauth_codes   enable row level security;
alter table oauth_tokens  enable row level security;
