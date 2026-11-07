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
5. `/api/shops/harts/bookings` returns 200 with a `bookings` array (it may be empty).
6. `/api/shops/nope/services` returns 404 with `{"error":{"code":"not_found",…}}`, not a 500 or an HTML page.
7. `/api/mcp` answers a plain browser visit (`GET`) with 405. That's expected: the MCP route only takes `POST`. A 404 or 500 means the route is broken.

Never book on production. The booking loop (`book`, then the same slot again → `slot_taken`) runs only on a preview whose `/api/shops/harts/services` shows "Hart's Barbers (preview)". Otherwise skip it; see `docs/VERIFIER.md` → Writes on previews.

Add a line here whenever a feature ships that must never break. Keep each one a quick pass/fail check on a URL.
