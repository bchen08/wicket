-- Front Desk, Ring 1c: deposits through Stripe Checkout (test mode, the platform account).
-- Apply once per database, after 0003_consent.sql. Seeds nothing. See docs/deposits.md and docs/database.md.
--
-- Approving a booking whose service has a deposit (within the deposit horizon) moves it to
-- 'awaiting_deposit' and opens a Stripe Checkout Session that places a hold (manual capture) on the
-- person's card. Paying confirms it; not paying by pay_by expires it. The owner's actions then capture
-- the hold (no-show, late cancel) or release it (complete, cancel in time). No webhook: the server asks
-- Stripe whenever it reads a booking that is awaiting its deposit.
-- Additive only: nullable columns, and one column with a default. Same access model as 0001 (no new table).

alter table bookings
  -- The Checkout Session that collects the deposit, and its URL (the Pay button). Set on approve.
  add column checkout_session_id text,
  add column checkout_url        text,
  -- The PaymentIntent holding the deposit, once the person has paid (authorized, not captured).
  add column payment_intent_id   text,
  -- When an awaiting_deposit booking lapses: approve time + 30 minutes.
  add column pay_by              timestamptz,
  -- Where the deposit stands: Booking.deposit.state.
  add column deposit_state       text not null default 'none',
  -- The last capture or release Stripe refused: { action, message, at }. Null once one succeeds.
  add column deposit_failure     jsonb,
  add constraint bookings_deposit_state_check check (
    deposit_state in ('none', 'awaiting_payment', 'held', 'captured', 'released', 'not_collected')
  ),
  add constraint bookings_deposit_failure_is_object check (
    deposit_failure is null or jsonb_typeof(deposit_failure) = 'object'
  ),
  add constraint bookings_deposit_has_deadline check (status <> 'awaiting_deposit' or pay_by is not null);

-- Bookings confirmed before deposits existed never collected theirs.
update bookings set deposit_state = 'not_collected'
where deposit_cents > 0 and status in ('confirmed', 'completed', 'no_show');
