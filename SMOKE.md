# Smoke checklist

Run this on the Vercel preview URL for every PR, and on production after every merge.
These must always work. If an agent's change breaks one, the PR does not merge.

Preview URLs are behind Vercel Authentication: open them in a browser signed in to the team's Vercel account.
A plain `curl` gets a 302 to the login page, which is not a failure.

## Site

1. The homepage loads with no error, no blank sections, and no console errors from the page itself.
2. `/api/health` returns `{"status":"ok","service":"emergent"}`.
3. Every link and button in the header goes somewhere real (no dead `#` links).

## Front Desk API (Ring 0)

4. `/api/shops/harts/services` returns Hart's Barbers (`America/New_York`) with 3 services: `haircut`, `beard-trim`, `haircut-beard`.
   This also proves the database is connected. A 500 with `code: "internal"` usually means `DATABASE_URL` is missing for that environment, or the deployment wasn't redeployed after it was set.
5. `/api/shops/harts/bookings` without a token or cookie returns 401 with `"next_action": "Open /console/unlock and enter the shop's access code."`. With `Authorization: Bearer $OWNER_API_TOKEN` it returns 200 with a `bookings` array (it may be empty). A 401 saying "Owner access isn't set up" means `OWNER_API_TOKEN` is missing for that environment.
6. `/api/shops/nope/services` returns 404 with `{"error":{"code":"not_found",…}}`, not a 500 or an HTML page.
7. `/api/mcp` answers a plain browser visit (`GET`) with 405. That's expected: the MCP route only takes `POST`. A 404 or 500 means the route is broken.

## Owner console

8. `/console` in a browser with no `fd_owner` cookie (a private window) says to open `/console/unlock` and enter the shop's access code.
9. At `/console/unlock`, a wrong code shows "That access code didn't work." The right code (`OWNER_API_TOKEN`) lands on `/console`, which lists the bookings: ones awaiting approval included, with the phone number when one was given.
10. `/approve/not-a-real-token` shows "This link isn't valid", not an error page.

## Booking loop (previews with their own database only)

Never book on production. These checks run only on a preview whose `/api/shops/harts/services` shows "Hart's Barbers (preview)". Otherwise skip them; see `docs/VERIFIER.md` → Writes on previews. Connect an MCP client (MCP Inspector, or a Claude custom connector with a bypass link) to `<preview>/api/mcp`.

11. `book` a Haircut at one of `get_availability`'s starts → `status: "awaiting_approval"` and `booking.approval.url` on the preview's own origin (`<preview>/approve/<token>`). `book` the same start again → `slot_taken`.
12. `get_booking` on that booking returns the same `approval.url`.
13. Open the link on a phone: it shows the shop, service, time, price, deposit ("not charged yet"), the cancellation rules, who booked it and the name, and "Hold expires at …". Tap **Approve** (with or without a phone number) → "You're booked". `get_booking` shows `confirmed` with `customer.approved: true` (and `customer.phone` if one was given).
14. Book another start and tap **Decline** on its link → `get_booking` shows `cancelled`, and the start is back in `get_availability`.
15. Book another start and leave its link alone for 10 minutes → `get_booking` shows `expired`, the link says the request has expired, and the start is back in `get_availability`.
16. Tool descriptions, tool result text and the approval page call a booking the person approved "approved", and never claim the customer's identity was checked.

Add a line here whenever a feature ships that must never break. Keep each one a quick pass/fail check on a URL.
