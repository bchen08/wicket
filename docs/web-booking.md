# Front Desk web booking API (no MCP)

Plain HTTP routes for booking, so an agent that can only make web requests, or drive a browser, can book Hart's without MCP. The web booking page (v0) uses the same routes. It's the same engine as the [MCP tools](frontdesk-api.md): the routes call the same service-layer functions (`getAvailability`, `book`), so the slots, the rules, the error codes and the approval link are the same.

**No booking is final until a real person approves it.** Booking holds the slot for 10 minutes and returns an approval link (`/approve/<token>`); the person opens it and approves or declines. See [Consent flow](frontdesk-api.md#consent-flow).

| | |
|---|---|
| Base | `<origin>/api/shops/harts` |
| Auth | None, like the MCP tools (`TODO(ring-2)`: agent sign-in) |
| Routes | `GET …/availability`, `POST …/book`, `GET …/booking-page`, `GET …/agents.md`, `GET /.well-known/front-desk.json` |
| Code | Routes in `app/api/shops/[shop]/{availability,book,booking-page,agents.md}/route.ts` and `app/api/well-known/front-desk/route.ts`; HTTP in `lib/server/frontdesk/web-http.ts`; use cases in `lib/server/frontdesk/web-booking.ts` |
| Types | [`lib/types/web-booking.ts`](../lib/types/web-booking.ts), re-exported from `lib/types/frontdesk.ts`: `AvailabilityDay`, `WebAvailabilityResponse`, `WebBookRequest`, `WebBookResponse`, `BookingPageService`, `BookingPageResponse`, `FrontDeskDiscovery` |

Conventions are the MCP API's ([Conventions](frontdesk-api.md#conventions)): money in integer cents, instants as RFC 3339 with the shop's offset, `display` strings in the shop's zone, every response `Cache-Control: no-store`. Errors are the `ApiError` envelope with the HTTP status from the [error codes](frontdesk-api.md#error-codes) table:

```json
{ "error": { "code": "slot_taken", "message": "…", "next_action": "…", "details": { } } }
```

**Errors in the web API's words.** The service layer writes errors for MCP callers. The web routes keep the code, the status and the details, but:
- `details.field` uses the web field names: `service_id` → `service`, `customer_name` → `name`;
- the message and `next_action` name the web routes instead of the tools: `get_availability` → `GET /api/shops/harts/availability`, `list_services` → `GET /api/shops/harts/services`, and the field names as above.

For example, `outside_hours`'s next_action is "Call GET /api/shops/harts/availability and choose one of the returned starts."

## `GET /api/shops/[shop]/availability` → `WebAvailabilityResponse`

Open start times for one service, day by day in the shop's time zone. Public, read-only: it holds nothing.

| Query | Notes |
|---|---|
| `service` | Required. A service id, e.g. `haircut` (`GET /api/shops/harts/services` lists them). |
| `from` | Optional. The first day, `YYYY-MM-DD` in the shop's zone (`America/New_York`), between 2000 and 2999. Default: today there. |
| `days` | Optional. How many days, a whole number from 1 to 14. Default: 7. |

Each day's `slots` are exactly what the MCP `get_availability` tool returns for `[that day's local midnight, the next local midnight)`: the same rules (15-minute grid, opening hours, busy time, lead time, horizon, pause), the same `Slot` shape and order. The route calls `getAvailability` once per day with `limit: 50`, and pages while a day is `truncated`, so no slot is cut off; it never returns `truncated`. Because each call covers one day, a 14-day range that crosses a clock change works, although one 14-day MCP window there would be 337 hours and refused.

```bash
curl -s "http://localhost:3000/api/shops/harts/availability?service=haircut&from=2026-11-14&days=2"
```

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "service": { "id": "haircut", "name": "Haircut", "durationMin": 30, "priceCents": 3500, "depositCents": 1000 },
  "from": "2026-11-14",
  "to": "2026-11-16",
  "days": [
    {
      "date": "2026-11-14",
      "display": "Sat 14 Nov",
      "slots": [
        { "start": "2026-11-14T09:00:00-05:00", "end": "2026-11-14T09:30:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 9:00 am EST" },
        { "start": "2026-11-14T09:15:00-05:00", "end": "2026-11-14T09:45:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 9:15 am EST" },
        "…"
      ]
    },
    { "date": "2026-11-15", "display": "Sun 15 Nov", "slots": [] }
  ],
  "paused": false,
  "phone": "+1 212-555-0142"
}
```

- `days` has one entry per day, empty days included: closed, fully booked, before the lead time, beyond the horizon (6 days for a haircut, which has a deposit), or paused.
- `paused: true`: the owner paused bookings, so every day is empty. Tell the person to call `phone`.
- Errors: **400** `invalid_request` for a missing `service`, a `from` that isn't a real `YYYY-MM-DD` date, or `days` outside 1–14 (`details.field` names it); **404** `not_found` for an unknown service (`details.valid_service_ids`) or shop.

## `POST /api/shops/[shop]/book`

Holds a start until the person approves it: the MCP `book` tool's use case, with the web field names. Same rules, same order of checks, same errors (see [`book`](frontdesk-api.md#book)). Call it once per booking: booking the same start again while the hold is on gets `slot_taken`.

It takes JSON, or a plain HTML form post (`application/x-www-form-urlencoded` or `multipart/form-data`). Unknown fields are ignored (a form's submit button, say).

| Field (`WebBookRequest`) | Notes |
|---|---|
| `service` | Required. A service id. |
| `start` | Required. A slot `start` from the availability route for that service, copied exactly (RFC 3339 with offset). |
| `name` | Required. The name the booking is under, 1–80 characters after trimming, no NUL character. |
| `bookedBy` | Optional. The agent's name; the person sees it on the approval page and the shop in its console. Without it (or blank), the booking's agent is `web (<the first 60 characters of the User-Agent>)`, or `web` with no User-Agent. Control characters are removed and it's cut to 80 characters, like an MCP client's name. |
| `mandate` | Optional, JSON only. The person's limits, as in MCP `book` ([Mandate](frontdesk-api.md#mandate)). |

### JSON → 201 `WebBookResponse`

```bash
curl -s -X POST http://localhost:3000/api/shops/harts/book -H "Content-Type: application/json" \
  -d '{"service":"haircut","start":"2026-11-14T14:30:00-05:00","name":"Maya","bookedBy":"Maya'\''s assistant"}'
```

```json
{
  "booking": {
    "id": "bd3db26a-83b1-403c-b923-357982915d3c",
    "shopSlug": "harts",
    "serviceId": "haircut",
    "serviceName": "Haircut",
    "staffId": "dana",
    "start": "2026-11-14T14:30:00-05:00",
    "end": "2026-11-14T15:00:00-05:00",
    "display": "Sat 14 Nov, 2:30 pm EST",
    "status": "awaiting_approval",
    "customer": { "displayName": "Maya", "approved": false, "verified": false },
    "agent": { "name": "Maya's assistant" },
    "depositCents": 1000,
    "createdAt": "2026-11-10T11:00:00-05:00",
    "approval": {
      "url": "http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM",
      "expiresAt": "2026-11-10T11:10:00-05:00"
    }
  },
  "statusUrl": "http://localhost:3000/api/approvals/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM",
  "next_action": "Held Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. It is not confirmed yet. Send Maya this link right away to approve or decline: http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM. The hold lapses at Tue 10 Nov, 11:10 am EST. Then GET http://localhost:3000/api/approvals/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM to see what they did: status pending, awaiting_deposit (approved, deposit not paid yet: send the same link again), approved, declined or expired. Don't book this time again while the hold is on."
}
```

- `booking` is the same `Booking` MCP `book` returns. `approval.url` is on the origin of this request, so it works on previews and in production.
- `statusUrl` is the approval link's own API, [`GET /api/approvals/<token>`](frontdesk-api.md#get-apiapprovalstoken--approvalview): its `status` is `pending`, `awaiting_deposit` (approved, but the deposit isn't paid yet; see [deposits.md](deposits.md)), `approved`, `declined` or `expired`. It's how a web agent checks the answer (there's no web `get_booking`).
- Errors: the `ApiError` envelope with its status, e.g. **409** `slot_taken` (with `details.alternatives`), **422** `outside_hours`, `too_soon`, `too_far`, `outside_mandate`, **409** `paused`, **400** `invalid_request` (including a body that isn't a JSON object: `details.field: "body"`).

```json
{
  "error": {
    "code": "outside_hours",
    "message": "That isn't a bookable time for Haircut.",
    "next_action": "Call GET /api/shops/harts/availability and choose one of the returned starts.",
    "details": { "field": "start", "value": "2026-11-14T12:00:00-05:00", "service_id": "haircut" }
  }
}
```

### A form post → 303

A browser agent (or the booking page) can post a plain HTML form:

```html
<form method="post" action="/api/shops/harts/book">
  <input type="hidden" name="service" value="haircut" />
  <input type="radio" name="start" value="2026-11-14T14:30:00-05:00" /> Sat 14 Nov, 2:30 pm EST
  <input name="name" />
  <input type="hidden" name="bookedBy" value="My browser agent" />
  <button>Book</button>
</form>
```

- **Booked:** 303 with `Location: <origin>/approve/<token>`, so the browser lands on the booking's approval page.
- **Refused:** 303 back to the page the form was on (the `Referer`), with `?error=<code>&message=<text>` added (its other query parameters kept, its `#fragment` dropped; an earlier `error` and `message` are replaced). E.g. `/book/harts?error=slot_taken&message=That+time+is+already+booked.` The page shows the message.
- **Refused, with no usable `Referer`:** the `ApiError` envelope as JSON with its status, as for JSON.

```bash
curl -s -i -X POST http://localhost:3000/api/shops/harts/book \
  -H "Referer: http://localhost:3000/book/harts" \
  -d service=haircut -d start=2026-11-14T14:30:00-05:00 -d name=Maya
# HTTP/1.1 303 See Other
# location: http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM
```

## `GET /api/shops/[shop]/booking-page` → `BookingPageResponse`

Everything the web booking page needs in one call. Public.

| Field | Notes |
|---|---|
| `shop` | The shop. |
| `services` | Every service in the shop's order, each a `Service` plus `days`: the next 7 days of open starts (today first), the same as the availability route's `days` for that service. |
| `policies` | The shop's `Policies` (as `get_policies`). `paused: true`: no starts are offered; show `phone`. |
| `policiesText` | The rules for the person, one sentence per line (split on `"\n"`): lead time, horizons, the cancellation window, the three rule texts, the phone. While paused, the first line says so. |
| `from` | Today, `YYYY-MM-DD` in the shop's zone. |
| `bookUrl` | Where the form posts: `<origin>/api/shops/harts/book`. |

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "services": [
    { "id": "haircut", "name": "Haircut", "durationMin": 30, "priceCents": 3500, "depositCents": 1000, "days": [{ "date": "2026-11-10", "display": "Tue 10 Nov", "slots": ["…"] }, "…"] },
    "…"
  ],
  "policies": { "leadTimeMin": 120, "horizonDays": 30, "depositHorizonDays": 6, "cancelWindowHours": 24, "paused": false, "phone": "+1 212-555-0142", "depositRule": "…", "lateCancelRule": "…", "noShowRule": "…" },
  "policiesText": "Book at least 2 hours ahead.\nServices without a deposit can be booked up to 30 days ahead; services with a deposit up to 6 days ahead.\nCancel at least 24 hours before your appointment and the deposit is released; cancel later and the shop keeps it.\nDeposit: …\nLate cancellation: …\nNo-show: …\nPhone: +1 212-555-0142.",
  "from": "2026-11-10",
  "bookUrl": "http://localhost:3000/api/shops/harts/book"
}
```

For the page (v0): read this route; render each service's `days` and slots by their `display`; post a form with `service`, `start` (the slot's `start`), `name` and optionally `bookedBy` to `bookUrl`; show `?error` and `?message` when the page is loaded with them. On success the browser goes to the approval page by itself.

## `GET /api/shops/[shop]/agents.md`

Plain text (`text/plain; charset=utf-8`, Markdown) for AI agents. It's built from the shop's live data on the request's origin, and says, with nothing else to read:
1. the hold and the approval link, in two sentences;
2. MCP first: the endpoint (`<origin>/api/mcp`) and the tools;
3. the web API step by step: the services (ids, durations, prices, deposits), the availability URL with today's date, the JSON book request and a curl line, the form alternative, sending `booking.approval.url`, and checking `statusUrl`;
4. the error codes and what to do, and that the web API can't cancel yet (decline on the page, the MCP `cancel` tool, or the shop's phone);
5. the shop's rules: the same text as `get_policies`.

An unknown shop is the 404 `ApiError` envelope (JSON).

## `GET /.well-known/front-desk.json` → `FrontDeskDiscovery`

Where agents find Front Desk. `next.config.ts` rewrites it to `/api/well-known/front-desk`. It reads no data, so it answers even when the database is down.

```json
{
  "name": "Front Desk",
  "description": "Book appointments at small businesses. Use the MCP endpoint if you can; otherwise the web API. No booking is final until the person approves it with the link booking returns. agentsMd explains it all.",
  "shop": "harts",
  "mcp": "http://localhost:3000/api/mcp",
  "webApi": "http://localhost:3000/api/shops/harts",
  "agentsMd": "http://localhost:3000/api/shops/harts/agents.md",
  "endpoints": {
    "availability": "http://localhost:3000/api/shops/harts/availability",
    "book": "http://localhost:3000/api/shops/harts/book",
    "bookingPage": "http://localhost:3000/api/shops/harts/booking-page"
  }
}
```

## Try it

```bash
FRONTDESK_NOW=2026-11-10T10:00:00-05:00 pnpm dev
O=http://localhost:3000/api/shops/harts

curl -s "$O/agents.md"
curl -s "$O/availability?service=haircut&from=2026-11-14&days=1"
curl -s -X POST $O/book -H "Content-Type: application/json" \
  -d '{"service":"haircut","start":"2026-11-14T14:30:00-05:00","name":"Maya","bookedBy":"curl"}'
# The same start again → 409 slot_taken, with details.alternatives
curl -s -X POST $O/book -H "Content-Type: application/json" \
  -d '{"service":"haircut","start":"2026-11-14T14:30:00-05:00","name":"Jo"}'
# A form post → 303 to the approval page
curl -s -i -X POST $O/book -H "Referer: http://localhost:3000/" \
  -d service=beard-trim -d start=2026-11-14T16:00:00-05:00 -d name=Lee
curl -s http://localhost:3000/.well-known/front-desk.json
```

## Not built yet

| Ring | Item | Where |
|---|---|---|
| ring-2 | Agent sign-in: `book` is open to anyone, like MCP `book` | `app/api/shops/[shop]/book/route.ts` |
| — | Cancelling over the web API (today: decline on the approval page while the hold is on, MCP `cancel`, or the shop's phone) | `lib/server/frontdesk/web-booking.ts` |
| — | The web booking page itself (v0), reading `booking-page` | `app/**/page.tsx` |
