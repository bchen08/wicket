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
- The owner checks use `harts-preview` on previews. Elsewhere pass `--owner-token <OWNER_API_TOKEN>`, or the checks that need it (the owner lists, and the alerts in the booking loop) are SKIPPED.
- The booking loop (items 11–14, 17 and 19, the web bookings W4–W5, the nightly tidy-up, 23, and connector sign-in's S5–S7) runs only where `/api/status` says `database.writesAllowed: true`, and the run declines (or, once approved, cancels) every booking it made, even after a failure. Its bookings show the agent `front-desk-smoke`.
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
5. **[smoke]** `/api/shops/harts/bookings` without a token or cookie returns 401 with `"next_action": "Open /console/unlock and enter the shop's access code."`. With `Authorization: Bearer $OWNER_API_TOKEN` it returns 200 with a `bookings` array (it may be empty). A 401 saying "Owner access isn't set up" means `OWNER_API_TOKEN` is missing for that environment. `/api/shops/harts/alerts` answers the same way, with an `alerts` array.
6. **[smoke]** `/api/shops/nope/services` returns 404 with `{"error":{"code":"not_found",…}}`, not a 500 or an HTML page.
7. **[smoke]** `/api/mcp` answers a plain browser visit (`GET`) with 405. That's expected: the MCP route only takes `POST`. A 404 or 500 means the route is broken. `pnpm smoke` also checks that it answers an MCP `initialize` and lists the seven tools.

## Owner console

8. **[browser]** `/console` in a browser with no `fd_owner` cookie (a private window) says to open `/console/unlock` and enter the shop's access code.
9. **[browser]** At `/console/unlock`, a wrong code shows "That access code didn't work." The right code (`OWNER_API_TOKEN`; `harts-preview` on previews) lands on `/console`, which lists the bookings: ones awaiting approval included, with the phone number when one was given.
10. **[browser]** `/approve/not-a-real-token` shows "This link isn't valid", not an error page.

## Web booking API (plain web requests, no MCP)

The same engine as the MCP tools, over plain HTTP (see [docs/web-booking.md](docs/web-booking.md)). W1–W3 are read-only and run everywhere. W4–W5 book, so like the booking loop they run only where `/api/status` shows `"writesAllowed": true`, and the run declines what they book.

- **W1 [smoke]** `/api/shops/harts/availability?service=haircut` returns 200 with `days`: 7 entries starting today (New York), each slot with a `start` and a `display` such as `"Sat 14 Nov, 2:30 pm EST"`.
- **W2 [smoke]** `/api/shops/harts/agents.md` returns plain text naming this deployment's MCP endpoint (`<origin>/api/mcp`), the availability route, the book route (`<origin>/api/shops/harts/book`) and `booking.approval.url`. **[by hand]** Read it as an agent would: it's enough to book with curl, without any other docs.
- **W3 [smoke]** `/.well-known/front-desk.json` returns JSON whose `mcp`, `webApi` and `agentsMd` are on this deployment's origin.
- **W4 [smoke]** `POST /api/shops/harts/book` with JSON `{"service":"haircut","start":<a W1 start>,"name":…,"bookedBy":"front-desk-smoke"}` → 201, `booking.status: "awaiting_approval"`, `booking.approval.url` on this origin, agent `front-desk-smoke`. The same start posted as a form (with a `Referer`) → 303 back to the Referer with `?error=slot_taken&message=…`. Declining the booking through `/api/approvals/<token>/decline` → `cancelled`.
- **W5 [smoke]** A plain HTML form post (`application/x-www-form-urlencoded`: `service`, `start`, `name`) of another start → 303 with `Location: <origin>/approve/<token>`. **[browser]** Follow that Location in a browser: the approval page shows that booking.

## Booking loop (previews with their own database only)

Never book on production. These checks run only where `/api/status` shows `"writesAllowed": true` (the Preview database, whose shop is "Hart's Barbers (preview)"). `pnpm smoke` checks that itself and skips them otherwise; see `docs/VERIFIER.md` → Writes on previews. For the **[browser]** ones, connect an MCP client (MCP Inspector, or a Claude custom connector with a bypass link) to `<preview>/api/mcp`.

11. **[smoke]** `book` a Haircut at one of `get_availability`'s starts → `status: "awaiting_approval"` and `booking.approval.url` on the preview's own origin (`<preview>/approve/<token>`). `book` the same start again → `slot_taken`.
12. **[smoke]** `get_booking` on that booking returns the same `approval.url`.
13. **[browser]** Open the link on a phone: it shows the shop, service, time, price, deposit ("not charged yet"), the cancellation rules, who booked it and the name, and "Hold expires at …". Tap **Approve** (with or without a phone number) → "You're booked". `get_booking` shows `confirmed` with `customer.approved: true` (and `customer.phone` if one was given). Where `/api/status` says `"deposits": "stripe_test"`, a Haircut goes to Stripe first (item 20); a Beard trim (no deposit) still lands on "You're booked" at once.
14. **[smoke]** Book another start and decline it (`pnpm smoke` posts to `/api/approvals/<token>/decline`, as the page's **Decline** button does) → `get_booking` shows `cancelled`, the start is back in `get_availability`, and `/api/shops/harts/alerts` (owner token) lists a `booking_cancelled` alert for that booking, `logged` on previews.
15. **[by hand]** Book another start and leave its link alone for 10 minutes → `get_booking` shows `expired`, the link says the request has expired, and the start is back in `get_availability`.
16. **[by hand]** Tool descriptions, tool result text and the approval page call a booking the person approved "approved", and never claim the customer's identity was checked.
17. **[smoke]** Book a Beard trim (no deposit, so it confirms whether or not deposits are on) and approve it (`pnpm smoke` posts `{}` to `/api/approvals/<token>/approve`, as the page's **Approve** button does) → `confirmed`, and `/api/shops/harts/alerts` (owner token) lists a `booking_confirmed` alert for that booking, `logged` on previews (they have no `RESEND_API_KEY`). The run then cancels it with `cancel`, which records one more `booking_cancelled` alert.

## Owner alerts on production (by hand, after a merge that touches alerts)

18. **[by hand]** With `RESEND_API_KEY` set for Production and Hart's `ownerEmail` set to the Resend account's address, `/api/status` on production shows `"alerts": "email"`. After the next real booking is approved, the owner's inbox has "New booking: …" within a minute (service, time, name, agent), and `/api/shops/harts/alerts` shows it `sent`. A cancellation or decline sends "Cancelled: …". Never book on production to test this: wait for a real booking, or check the alerts list.

## Deposits (Stripe Checkout, test mode)

`/api/status` says `"deposits": "stripe_test"` when `STRIPE_SECRET_KEY` (a `sk_test_…` key) is set for that environment, and `"off"` otherwise. `off` is not a problem: bookings confirm without a deposit. See [docs/deposits.md](docs/deposits.md).

19. **[smoke]** Book a Haircut and approve it (`pnpm smoke` posts JSON to `/api/approvals/<token>/approve`). With `stripe_test` → `status: "awaiting_deposit"`, `deposit.state: "awaiting_payment"` and `deposit.payUrl` on `https://checkout.stripe.com/`; `get_booking` shows the same and the same `approval.url`. It never pays. Then `cancel` it → `cancelled`, `deposit.state: "released"` (the Checkout page is closed), and the start is back in `get_availability`. With `off` → approving gives `confirmed` with `deposit.state: "not_collected"`, and cancelling frees the start.
20. **[browser]** (`stripe_test`) Open a Haircut's approval link and tap **Approve** → Stripe's Checkout page asks for $10. Pay with `4242 4242 4242 4242`, any future date, any CVC → back on the approval page, which says "You're booked". `get_booking` shows `confirmed` and `deposit.state: "held"`; in the Stripe dashboard (test mode) → Payments, the $10 payment is **Uncaptured**.
21. **[by hand]** (`stripe_test`) Approve a Haircut and leave the Stripe page unpaid. 30 minutes later the approval page says the request has expired, `get_booking` shows `expired` with `deposit.state: "released"`, and the start is back in `get_availability`.
22. **[by hand]** (`stripe_test`) The owner moves the money. Set the lead time to 0 (`PUT /api/shops/harts/policies` with `{"leadTimeMin":0}`), book the next Haircut start, approve and pay it as in 20, and once it has started, `POST /api/shops/harts/bookings/<id>/no-show` → `deposit.state: "captured"`, and Stripe shows the $10 **Succeeded**. Do the same with another booking and `…/complete` → `deposit.state: "released"`, and Stripe shows that payment **Canceled**. Put the lead time back to 120 afterwards.
23. **[by hand]** On a deployment without `STRIPE_SECRET_KEY` (`"deposits": "off"`), approving a Haircut on its page lands on "You're booked", and the owner's list shows it with `deposit.state: "not_collected"`.

## Texting

`/api/status` says `"texting": "photon"` (iMessage), `"twilio"` (SMS) or `"off"`, by which variables are set (Production only; see [docs/texting.md](docs/texting.md)). `off` is not a problem: nothing is texted and everything works as before. `pnpm smoke` runs T1–T4 (`scripts/smoke-checks/texting.mjs`); it never texts anyone.

- **T1 [smoke]** `/api/status` has `texting`: `photon`, `twilio` or `off`.
- **T2 [smoke]** Where texting is `off`: `POST /api/owner/code` → 400 `invalid_request` with `details.reason: "texting_off"`. SKIPPED where texting is on: it would text the owner (T5).
- **T3 [smoke]** `POST /api/owner/session` with `{"code":"000000"}` → 401 `unauthorized`, and no cookie.
- **T4 [smoke]** Where writes are allowed and texting is `off`: MCP `book` with `customer_phone` → `texted: false` and `booking.customer.phone` is that number; the run then declines it. SKIPPED where texting is on.
- **T5 [by hand]** (production, texting on, Hart's `ownerMobile` set) At `/console/unlock`, tap **Text me a code** → the owner's phone gets "<6 digits> is your Front Desk code for Hart's Barbers…" within a minute, and the page asks for it. Enter it → `/console`. Enter the same code again (in a private window) → "That code didn't work". Where texting is off, the page shows only the access-code form.
- **T6 [by hand]** (production, texting on) The next real booking an agent makes with the person's phone: the person gets "<agent> asked Hart's Barbers to book … Approve or decline: <link>", and the agent's result said `texted: true`. Once it's approved (or cancelled), the owner's phone gets "New booking: …" (or "Cancelled: …"), and `/api/shops/harts/alerts` lists a `text` alert `sent` next to the email or log one. Never book on production to test this: wait for a real booking.

## Connector sign-in (Claude and ChatGPT connectors)

Front Desk is the OAuth authorization server for its own MCP endpoint, so a person connects it to Claude or ChatGPT once, signs in with their name and mobile number, and their agent books as them. See [docs/connector-signin.md](docs/connector-signin.md). S1–S4 are read-only and run everywhere; S5–S7 sign in and book, so they run only where `/api/status` shows `"writesAllowed": true` (the booking they make is cancelled). The checks live in `scripts/smoke-checks/signin.mjs`.

- **S1 [smoke]** `/.well-known/oauth-protected-resource/api/mcp` returns `resource: <origin>/api/mcp` and `authorization_servers: [<origin>]`.
- **S2 [smoke]** `/.well-known/oauth-authorization-server` returns `issuer: <origin>`, the authorize, token and registration endpoints on this origin, `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true` and `token_endpoint_auth_methods_supported: ["none"]`.
- **S3 [smoke]** An MCP `tools/call` of `list_my_bookings` with no token → **HTTP 401** with `WWW-Authenticate: Bearer … resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"`. That 401 is what makes Claude show its sign-in step. (Every other anonymous call answers exactly as before; item 7 and the booking loop check that.)
- **S4 [smoke]** `/api/oauth/authorize` with an unknown `client_id` → 400 page, no redirect.
- **S5 [smoke]** Sign in as a test client: register (`POST /api/oauth/register`) → `GET /api/oauth/authorize` → 302 to `/signin`, which names the client → post the form (name `Smoke Test`, a fictional 555-01xx number, Allow) → 303 to the client's redirect URI with `code`, `state` and `iss` → `POST /api/oauth/token` with the PKCE verifier → an access token (3600 s) and a refresh token.
- **S6 [smoke]** With that token, `book` a Beard trim **without** `customer_name` → booked for `Smoke Test` with the number; `list_my_bookings` lists it; `cancel` it → `cancelled`. SKIPPED where texting is on: it would text the number.
- **S7 [smoke]** The refresh token gets a new access token, and `list_my_bookings` works with it.
- **S8 [browser]** In Claude (Customize → Connectors → Add custom connector, URL `<origin>/api/mcp`; a preview needs a bypass link): Claude shows a sign-in step, either when connecting or as a **Connect** card the first time it needs it. Sign in with a name and number on `/signin`. Then "book me a haircut Wednesday morning" books without asking for a name (you still approve it with the link), "What appointments do I have at Hart's?" lists it, and "cancel the Wednesday one" cancels it.
- **S9 [browser]** An agent that never signs in can still browse and book as before (it is asked for a name, and gets the approval link).

Add a line here whenever a feature ships that must never break. Keep each one a quick pass/fail check on a URL, and mark it **[smoke]** (then add it to `scripts/smoke.mjs`), **[browser]** or **[by hand]**.

## Nightly tidy-up

Once a day (Vercel Cron, 08:00 UTC, production only) `GET /api/jobs/nightly` expires holds and unpaid deposits past their deadlines and completes confirmed bookings that ended more than 3 hours ago, releasing their deposit holds. See [docs/nightly.md](docs/nightly.md). It writes, so on previews it runs only where `/api/status` shows `"writesAllowed": true`.

23. **[smoke]** `GET /api/jobs/nightly` → 200 with `ranAt` and four whole counts: `expired`, `completed`, `depositsReleased`, `failures` (what they are depends on what's in the database). Then `/api/status` shows that run (or a later one) as `lastNightlyRun`. Calling it again is safe: a second run right after answers all four counts `0`.
24. **[by hand]** (production, the morning after a merge that touches the job) `/api/status` shows `lastNightlyRun` from between 08:00 and 09:00 UTC that day. A confirmed booking whose time passed the day before, that the owner didn't mark, shows `completed` in the console, and with `deposits: "stripe_test"` its $10 payment shows **Canceled** in the Stripe dashboard (test mode). Vercel → Settings → Cron Jobs lists `/api/jobs/nightly` at `0 8 * * *`.
