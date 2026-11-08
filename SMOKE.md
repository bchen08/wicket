# Smoke checklist

Run this on the Vercel preview URL for every PR, and on production after every merge.
These must always work. If an agent's change breaks one, the PR does not merge.

## Run it

`pnpm smoke` runs every check marked **[smoke]** from any computer with Node and a checkout of this repo:

```bash
pnpm smoke <PREVIEW_URL> --commit <PR head sha> --bypass <secret>
```

- It reads `/api/status` first (item 0). If the deployment isn't ready, or isn't at `--commit`, it prints `BLOCKED: <problems>`, runs nothing else and exits 2. **BLOCKED means the environment isn't ready, not that the code is broken.** Each problem says what to fix and where.
- Otherwise it prints PASS, FAIL or SKIPPED for each check, with evidence, then one verdict line. Exit code 0: everything passed (SKIPPED rows aren't failures, but they aren't passes either). 1: a check failed.
- Previews are behind Vercel Authentication. `--bypass` (or the env var `VERCEL_AUTOMATION_BYPASS_SECRET`) is the team's Protection Bypass for Automation secret; get it from a teammate. Without it, a preview answers with Vercel's login page and the run is `BLOCKED: preview needs the Vercel bypass secret (--bypass)`.
- The owner check uses `harts-preview` on previews. Elsewhere pass `--owner-token <OWNER_API_TOKEN>`, or that one check is SKIPPED.
- The booking loop runs only where `/api/status` says `database.writesAllowed: true`, and the run declines every booking it made, even after a failure. Its bookings show the agent `front-desk-smoke`.
- On production: `pnpm smoke https://<production domain> --owner-token <production token>`. The booking loop is SKIPPED there: production is never written to.

Items marked **[browser]** need a browser signed in to the team's Vercel account. **[by hand]** items need a person's judgment or a wait.

## Environment

0. **[smoke]** `/api/status` returns `"status": "ready"`, and its `commit` is the first 7 characters of the commit under test (the PR's head commit). Anything else is BLOCKED: `problems` says what to fix in the environment (a Vercel variable, the Preview database, a redeploy). Production shows `"writesAllowed": false`.

## Site

1. **[browser]** The homepage loads with no error, no blank sections, and no console errors from the page itself.
2. **[smoke]** `/api/health` returns `{"status":"ok","service":"emergent"}`.
3. **[browser]** Every link and button in the header goes somewhere real (no dead `#` links).

## Front Desk API (Ring 0)

4. **[smoke]** `/api/shops/harts/services` returns Hart's Barbers (`America/New_York`) with 3 services: `haircut`, `beard-trim`, `haircut-beard`.
   This also proves the database is connected. A 500 with `code: "internal"` usually means `DATABASE_URL` is missing for that environment, or the deployment wasn't redeployed after it was set; `/api/status` says which.
5. **[smoke]** `/api/shops/harts/bookings` without a token or cookie returns 401 with `"next_action": "Open /console/unlock and enter the shop's access code."`. With `Authorization: Bearer $OWNER_API_TOKEN` it returns 200 with a `bookings` array (it may be empty). A 401 saying "Owner access isn't set up" means `OWNER_API_TOKEN` is missing for that environment.
6. **[smoke]** `/api/shops/nope/services` returns 404 with `{"error":{"code":"not_found",…}}`, not a 500 or an HTML page.
7. **[smoke]** `/api/mcp` answers a plain browser visit (`GET`) with 405. That's expected: the MCP route only takes `POST`. A 404 or 500 means the route is broken. `pnpm smoke` also checks that it answers an MCP `initialize` and lists the six tools.

## Owner console

8. **[browser]** `/console` in a browser with no `fd_owner` cookie (a private window) says to open `/console/unlock` and enter the shop's access code.
9. **[browser]** At `/console/unlock`, a wrong code shows "That access code didn't work." The right code (`OWNER_API_TOKEN`; `harts-preview` on previews) lands on `/console`, which lists the bookings: ones awaiting approval included, with the phone number when one was given.
10. **[browser]** `/approve/not-a-real-token` shows "This link isn't valid", not an error page.

## Booking loop (previews with their own database only)

Never book on production. These checks run only where `/api/status` shows `"writesAllowed": true` (the Preview database, whose shop is "Hart's Barbers (preview)"). `pnpm smoke` checks that itself and skips them otherwise; see `docs/VERIFIER.md` → Writes on previews. For the **[browser]** ones, connect an MCP client (MCP Inspector, or a Claude custom connector with a bypass link) to `<preview>/api/mcp`.

11. **[smoke]** `book` a Haircut at one of `get_availability`'s starts → `status: "awaiting_approval"` and `booking.approval.url` on the preview's own origin (`<preview>/approve/<token>`). `book` the same start again → `slot_taken`.
12. **[smoke]** `get_booking` on that booking returns the same `approval.url`.
13. **[browser]** Open the link on a phone: it shows the shop, service, time, price, deposit ("not charged yet"), the cancellation rules, who booked it and the name, and "Hold expires at …". Tap **Approve** (with or without a phone number) → "You're booked". `get_booking` shows `confirmed` with `customer.approved: true` (and `customer.phone` if one was given). Where `/api/status` says `"deposits": "stripe_test"`, a Haircut goes to Stripe first (item 20); a Beard trim (no deposit) still lands on "You're booked" at once.
14. **[smoke]** Book another start and decline it (`pnpm smoke` posts to `/api/approvals/<token>/decline`, as the page's **Decline** button does) → `get_booking` shows `cancelled`, and the start is back in `get_availability`.
15. **[by hand]** Book another start and leave its link alone for 10 minutes → `get_booking` shows `expired`, the link says the request has expired, and the start is back in `get_availability`.
16. **[by hand]** Tool descriptions, tool result text and the approval page call a booking the person approved "approved", and never claim the customer's identity was checked.

## Deposits (Stripe Checkout, test mode)

`/api/status` says `"deposits": "stripe_test"` when `STRIPE_SECRET_KEY` (a `sk_test_…` key) is set for that environment, and `"off"` otherwise. `off` is not a problem: bookings confirm without a deposit. See [docs/deposits.md](docs/deposits.md). Items 17 and 18 are the owner-alerts PR's.

19. **[smoke]** Book a Haircut and approve it (`pnpm smoke` posts JSON to `/api/approvals/<token>/approve`). With `stripe_test` → `status: "awaiting_deposit"`, `deposit.state: "awaiting_payment"` and `deposit.payUrl` on `https://checkout.stripe.com/`; `get_booking` shows the same and the same `approval.url`. It never pays. Then `cancel` it → `cancelled`, `deposit.state: "released"` (the Checkout page is closed), and the start is back in `get_availability`. With `off` → approving gives `confirmed` with `deposit.state: "not_collected"`, and cancelling frees the start.
20. **[browser]** (`stripe_test`) Open a Haircut's approval link and tap **Approve** → Stripe's Checkout page asks for $10. Pay with `4242 4242 4242 4242`, any future date, any CVC → back on the approval page, which says "You're booked". `get_booking` shows `confirmed` and `deposit.state: "held"`; in the Stripe dashboard (test mode) → Payments, the $10 payment is **Uncaptured**.
21. **[by hand]** (`stripe_test`) Approve a Haircut and leave the Stripe page unpaid. 30 minutes later the approval page says the request has expired, `get_booking` shows `expired` with `deposit.state: "released"`, and the start is back in `get_availability`.
22. **[by hand]** (`stripe_test`) The owner moves the money. Set the lead time to 0 (`PUT /api/shops/harts/policies` with `{"leadTimeMin":0}`), book the next Haircut start, approve and pay it as in 20, and once it has started, `POST /api/shops/harts/bookings/<id>/no-show` → `deposit.state: "captured"`, and Stripe shows the $10 **Succeeded**. Do the same with another booking and `…/complete` → `deposit.state: "released"`, and Stripe shows that payment **Canceled**. Put the lead time back to 120 afterwards.
23. **[by hand]** On a deployment without `STRIPE_SECRET_KEY` (`"deposits": "off"`), approving a Haircut on its page lands on "You're booked", and the owner's list shows it with `deposit.state: "not_collected"`.

Add a line here whenever a feature ships that must never break. Keep each one a quick pass/fail check on a URL, and mark it **[smoke]** (then add it to `scripts/smoke.mjs`), **[browser]** or **[by hand]**.
