-- Front Desk, Ring 0 walking skeleton: shops, what they sell, when staff work, and bookings.
-- Apply once per database, then load supabase/seed.sql. See docs/database.md.
--
-- Access model: the Next.js server connects as the database owner through DATABASE_URL
-- (the Supabase transaction pooler). The browser never talks to the database. Row level
-- security is enabled on every table with NO policies, so Supabase's public API roles
-- (anon, authenticated) can read and write nothing.

-- Lets the exclusion constraint on bookings mix "=" on text with "&&" on ranges.
create extension if not exists btree_gist;

create table shops (
  slug     text primary key,
  name     text not null,
  -- IANA zone the shop's hours are written in, e.g. 'America/New_York'.
  timezone text not null
);

create table services (
  shop_slug     text    not null references shops (slug) on delete cascade,
  id            text    not null,
  name          text    not null,
  duration_min  integer not null check (duration_min > 0),
  price_cents   integer not null check (price_cents >= 0),
  -- Deposit the service requires, in cents. 0 = none. Not collected in Ring 0.
  deposit_cents integer not null default 0 check (deposit_cents >= 0),
  -- Display order in list_services.
  position      integer not null default 0,
  primary key (shop_slug, id)
);

create table staff (
  -- Staff ids are unique across shops so weekly_hours and bookings can reference them alone.
  id        text primary key,
  shop_slug text not null references shops (slug) on delete cascade,
  name      text not null
);

-- A staff member's regular week, in the shop's local time. A day can have several rows:
-- a lunch break is the gap between two of them (e.g. 09:00–12:00 and 12:30–17:00).
create table weekly_hours (
  staff_id text     not null references staff (id) on delete cascade,
  -- ISO weekday: 1 = Monday … 7 = Sunday.
  weekday  smallint not null check (weekday between 1 and 7),
  opens    time     not null,
  -- Appointments must end by this time.
  closes   time     not null,
  primary key (staff_id, weekday, opens),
  check (opens < closes)
);

create table bookings (
  id            uuid        primary key default gen_random_uuid(),
  shop_slug     text        not null references shops (slug),
  service_id    text        not null,
  staff_id      text        not null references staff (id),
  -- The appointment, half-open: [start, end).
  during        tstzrange   not null,
  status        text        not null default 'confirmed'
                            check (status in ('confirmed', 'cancelled')),
  -- As given by the agent. Unverified in Ring 0.
  customer_name text        not null check (char_length(customer_name) between 1 and 80),
  -- Best-effort label for the booking agent (the MCP client's name). Unverified in Ring 0.
  agent_name    text        not null,
  created_at    timestamptz not null default now(),
  foreign key (shop_slug, service_id) references services (shop_slug, id),
  constraint during_is_half_open check (
    not isempty(during) and lower_inc(during) and not upper_inc(during)
    and not lower_inf(during) and not upper_inf(during)
  ),
  -- The final word on double booking: one staff member can't have two confirmed
  -- bookings that overlap. Violations raise SQLSTATE 23P01 (exclusion_violation).
  constraint no_overlap exclude using gist (staff_id with =, during with &&)
    where (status = 'confirmed')
);

-- Bookings by shop and time: availability (busy time) and the UI's bookings list.
create index bookings_shop_during on bookings using gist (shop_slug, during);

alter table shops        enable row level security;
alter table services     enable row level security;
alter table staff        enable row level security;
alter table weekly_hours enable row level security;
alter table bookings     enable row level security;
