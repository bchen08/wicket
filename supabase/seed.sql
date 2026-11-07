-- Demo data: one shop, Hart's Barbers, with its booking rules. No bookings or blocked times.
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

-- Ring 1a (needs 0002_rules.sql): Hart's booking rules. Book at least 2 hours ahead, up to 30 days
-- ahead (6 days for services with a deposit), and cancel at least 24 hours ahead to keep the deposit.
-- An existing row is left alone, so re-running the seed never overwrites the owner's changes.
insert into policies (
  shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone,
  deposit_rule, late_cancel_rule, no_show_rule
) values (
  'harts', 120, 30, 6, 24, false, '+1 212-555-0142',
  'Services with a deposit need it when you book. We hold the deposit on your card at booking; it is only charged if you miss the appointment or cancel late.',
  'Cancel at least 24 hours before your appointment and the deposit is released. Cancel within 24 hours and we keep the deposit as a late-cancellation fee.',
  'If you don''t show up, we keep the deposit. Otherwise it is released after your appointment.'
)
on conflict (shop_slug) do nothing;
