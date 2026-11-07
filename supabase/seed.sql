-- Demo data for the Ring 0 skeleton: one shop, Hart's Barbers. No bookings.
-- Safe to run more than once. Keep in step with SEED in lib/server/frontdesk/memory-store.ts,
-- which the tests and local development (no DATABASE_URL) use.

insert into shops (slug, name, timezone) values
  ('harts', 'Hart''s Barbers', 'America/New_York')
on conflict (slug) do nothing;

insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position) values
  ('harts', 'haircut',       'Haircut',              30, 3500, 1000, 1),
  ('harts', 'beard-trim',    'Beard trim',           15, 1500,    0, 2),
  ('harts', 'haircut-beard', 'Haircut + beard trim', 45, 4500, 1000, 3)
on conflict (shop_slug, id) do nothing;

insert into staff (id, shop_slug, name) values
  ('dana', 'harts', 'Dana')
on conflict (id) do nothing;

-- Tue–Sat (ISO 2–6), with lunch 12:00–12:30 as the gap between the two windows.
insert into weekly_hours (staff_id, weekday, opens, closes)
select 'dana', day, window_.opens, window_.closes
from generate_series(2, 6) as day
cross join (values (time '09:00', time '12:00'), (time '12:30', time '17:00')) as window_ (opens, closes)
on conflict (staff_id, weekday, opens) do nothing;
