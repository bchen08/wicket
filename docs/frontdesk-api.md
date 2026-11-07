# Front Desk agent API (MCP)

Front Desk lets AI agents (Claude, ChatGPT, personal agents) ask a small business what it offers and when it's free, and book an appointment. Agents connect over the [Model Context Protocol](https://modelcontextprotocol.io). The UI reads the same data over two plain JSON routes.

| | |
|---|---|
| Endpoint | `<origin>/api/mcp`, e.g. `http://localhost:3000/api/mcp` or `https://<preview>.vercel.app/api/mcp` |
| Transport | Streamable HTTP, stateless (`POST` only; `GET` answers 405) |
| Auth | None yet |
| Shop | One shop for now: Hart's Barbers (`harts`), `America/New_York` |
| Tools | `list_services`, `get_availability` (read-only), and `book` |
| UI routes | `GET /api/shops/[shop]/services`, `GET /api/shops/[shop]/bookings` |
| Data | Postgres (Supabase). See [database.md](database.md). |

Request and response shapes are exported from [`lib/types/frontdesk.ts`](../lib/types/frontdesk.ts): `Shop`, `Service`, `Slot`, `Booking`, `BookingStatus`, `ApiError`, `ListServicesResult`, `GetAvailabilityInput`, `GetAvailabilityResult`, `BookInput`, `BookResult`, `ServicesResponse`, `BookingsResponse`.

## Conventions

- **Money** is integer cents in `structuredContent` (`3500` = $35.00). The text content shows dollars.
- **Times** are RFC 3339 with an offset, e.g. `2026-11-14T09:00:00-05:00`. Inputs may use any offset, including `Z`. Outputs use the shop's offset.
- **Time zone:** opening hours and `display` strings are in the shop's IANA zone (`America/New_York`).
- **Errors:** the result has `isError: true` and its text is a JSON `ApiError`:

  ```json
  { "error": { "code": "not_found", "message": "…", "next_action": "…", "details": { } } }
  ```

  `code` is `invalid_request`, `not_found`, `slot_taken` or `internal`. Agents should follow `next_action`.
  Every failure uses this envelope, including a missing field and a wrong JSON type (e.g. `"limit": "ten"`). `details.field` names the offending argument. `"limit": null` is treated as omitted.
  The envelope is in the text, not `structuredContent`. Clients such as MCP Inspector validate `structuredContent` against the tool's `outputSchema` even on errors, so they would reject it there.

## `list_services`

Lists the shop and every service it offers. No arguments.

**Input**

```json
{}
```

**Text content**

```
Hart's Barbers — times are in America/New_York.
- Haircut (id: haircut): 30 min, $35.00, $10.00 deposit
- Beard trim (id: beard-trim): 15 min, $15.00, no deposit
- Haircut + beard trim (id: haircut-beard): 45 min, $45.00, $10.00 deposit
Prices are in US dollars here and in integer cents in structuredContent.
```

**`structuredContent`** (`ListServicesResult`)

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "services": [
    { "id": "haircut", "name": "Haircut", "durationMin": 30, "priceCents": 3500, "depositCents": 1000 },
    { "id": "beard-trim", "name": "Beard trim", "durationMin": 15, "priceCents": 1500, "depositCents": 0 },
    { "id": "haircut-beard", "name": "Haircut + beard trim", "durationMin": 45, "priceCents": 4500, "depositCents": 1000 }
  ]
}
```

`depositCents: 0` means no deposit.

## `get_availability`

Returns open start times for one service in a window.

| Field | Type | Notes |
|---|---|---|
| `service_id` | string | Required. An `id` from `list_services`. |
| `from` | string | Required. RFC 3339 with offset. Inclusive. |
| `to` | string | Required. RFC 3339 with offset. Exclusive. After `from`, at most 14 days (336 hours) later. |
| `limit` | integer | Optional. 1–50, default 20. |

`from` and `to` must be real RFC 3339 instants:
- The offset is required.
- Hours run 00–23, and offsets go up to ±23:59.
- The date must exist; `2026-02-30` is rejected.

The 14-day limit is elapsed time: `to - from` ≤ 336 hours. A window from local midnight to local midnight two weeks later that crosses the November clock change is 337 hours, so it's rejected. Ask for slightly less, or split the window.

How it works:
- Starts are on a 15-minute grid from opening time, and the whole appointment must end by closing time.
- Past times are never returned.
- A start is dropped if `[start, start + duration)` overlaps any busy time, such as lunch or an existing booking. Busy times are half-open, so a slot can end exactly when a booking starts.
- Results are sorted by start. If `truncated` is `true`, more slots exist; call again with `from` set one minute after the last returned start.

**Input**

```json
{
  "service_id": "haircut",
  "from": "2026-11-14T00:00:00-05:00",
  "to": "2026-11-15T00:00:00-05:00",
  "limit": 3
}
```

**Text content**

```
3 open start time(s) for haircut:
- Sat 14 Nov, 9:00 am EST (start 2026-11-14T09:00:00-05:00, with dana)
- Sat 14 Nov, 9:15 am EST (start 2026-11-14T09:15:00-05:00, with dana)
- Sat 14 Nov, 9:30 am EST (start 2026-11-14T09:30:00-05:00, with dana)
More times exist. To see them, call again with from set one minute after the last start above.
```

**`structuredContent`** (`GetAvailabilityResult`)

```json
{
  "slots": [
    { "start": "2026-11-14T09:00:00-05:00", "end": "2026-11-14T09:30:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 9:00 am EST" },
    { "start": "2026-11-14T09:15:00-05:00", "end": "2026-11-14T09:45:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 9:15 am EST" },
    { "start": "2026-11-14T09:30:00-05:00", "end": "2026-11-14T10:00:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 9:30 am EST" }
  ],
  "truncated": true
}
```

With no bookings, a full Saturday (`limit: 50`) has 28 haircut starts: 9:00–11:30 and 12:30–16:30. There's no 11:45 start, because a 30-minute haircut then would run into lunch. Every booking removes the starts that would overlap it.

**Error example:** unknown service

```json
{
  "error": {
    "code": "not_found",
    "message": "No service with id \"perm\" at Hart's Barbers.",
    "next_action": "Call list_services to get valid service ids, then retry with one of them.",
    "details": { "service_id": "perm", "valid_service_ids": ["haircut", "beard-trim", "haircut-beard"] }
  }
}
```

Other `invalid_request` cases:
- a window over 14 days;
- `from` not before `to`;
- a date without an offset (e.g. `"2026-11-14"`) or with an impossible offset (e.g. `+99:99`);
- a `limit` that is not a whole number from 1 to 50;
- a missing field, or a field of the wrong JSON type.

## `book`

Books an appointment. **It's confirmed as soon as the call returns**: there's no hold-then-confirm step, so call it only once the user has picked a time.

- `start` must be one of the starts `get_availability` just returned for the same service. Any other time is refused.
- **No deposit is collected yet.** `depositCents` says what the service will require once deposits are enabled.
- **The customer is not verified.** `customer.verified` is always `false`.
- `agent.name` is a best-effort, unverified label: the MCP client's self-reported name. Clients on the 2026-07-28 protocol send it with every request. Stateless 2025-era requests don't, so those bookings show `"unknown agent"`. MCP Inspector is one of these.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`. Don't repeat a call that succeeded; there are no idempotency keys yet.

| Field | Type | Notes |
|---|---|---|
| `service_id` | string | Required. An `id` from `list_services`. |
| `start` | string | Required. A slot `start` from `get_availability`, RFC 3339 with offset. Any offset is accepted if it's the same instant. |
| `customer_name` | string | Required. 1–80 characters after trimming. The name the booking is under. |

**Input**

```json
{ "service_id": "haircut", "start": "2026-11-14T14:30:00-05:00", "customer_name": "Maya" }
```

**Text content**

```
Booked Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. A $10 deposit will be required once deposits are enabled; nothing was charged.
Booking id: 08c015f8-8945-47e9-bcd1-bf77fc944f25. It is confirmed now; don't call book again for it.
```

**`structuredContent`** (`BookResult`)

```json
{
  "booking": {
    "id": "08c015f8-8945-47e9-bcd1-bf77fc944f25",
    "shopSlug": "harts",
    "serviceId": "haircut",
    "serviceName": "Haircut",
    "staffId": "dana",
    "start": "2026-11-14T14:30:00-05:00",
    "end": "2026-11-14T15:00:00-05:00",
    "display": "Sat 14 Nov, 2:30 pm EST",
    "status": "confirmed",
    "customer": { "displayName": "Maya", "verified": false },
    "agent": { "name": "unknown agent" },
    "depositCents": 1000,
    "createdAt": "2026-11-07T15:25:07.890-05:00"
  }
}
```

**How it decides:**
1. It checks the arguments.
2. It recomputes availability for that service at `start`, using the current clock. `start` must be one of the slots, and the staff member comes from that slot.
3. It stores the booking. The database's `no_overlap` constraint has the final word, so two agents racing for the same time can't both win.
4. It notifies the owner. In Ring 0 that's one JSON log line, `booking.created`, with the customer's first name only. A notifier failure never fails the booking.

**Errors**

| `code` | When | `next_action` |
|---|---|---|
| `slot_taken` | The time is already booked. This covers booking the same slot twice, an overlapping service (e.g. a 45-min haircut-beard at 9:45 when 10:00 is booked), and losing a race to another agent. | "Someone just took that time. Call get_availability again and choose another start." |
| `invalid_request` | `start` isn't a bookable time: off the 15-minute grid, outside opening hours (including lunch, 12:00–12:30), on a closed day, or in the past. | "Call get_availability and choose one of the returned starts." |
| `invalid_request` | Unknown `service_id` | Call `list_services` (`details.valid_service_ids` lists them). |
| `invalid_request` | `start` isn't RFC 3339 with an offset; `customer_name` is missing, blank or over 80 characters; a field is missing or the wrong JSON type | Says what to send instead. `details.field` names the argument. |

```json
{
  "error": {
    "code": "slot_taken",
    "message": "That time is already booked.",
    "next_action": "Someone just took that time. Call get_availability again and choose another start.",
    "details": { "start": "2026-11-14T14:30:00-05:00", "service_id": "haircut" }
  }
}
```

## HTTP routes for the UI

Plain JSON, request-time only (never cached; `Cache-Control: no-store`). Types are in `lib/types/frontdesk.ts`. An unknown shop returns **404** with the `ApiError` envelope:

```json
{ "error": { "code": "not_found", "message": "No shop with slug \"nope\".", "next_action": "Check the shop slug. Front Desk currently serves one shop: harts.", "details": { "shop": "nope" } } }
```

Other failures return **500** with `code: "internal"`.

### `GET /api/shops/[shop]/services` → `ServicesResponse`

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "services": [
    { "id": "haircut", "name": "Haircut", "durationMin": 30, "priceCents": 3500, "depositCents": 1000 },
    { "id": "beard-trim", "name": "Beard trim", "durationMin": 15, "priceCents": 1500, "depositCents": 0 },
    { "id": "haircut-beard", "name": "Haircut + beard trim", "durationMin": 45, "priceCents": 4500, "depositCents": 1000 }
  ]
}
```

### `GET /api/shops/[shop]/bookings` → `BookingsResponse`

Confirmed and cancelled bookings whose time falls between 7 days ago and 30 days ahead, sorted by `start`. Each item is a `Booking`, the same shape `book` returns.

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "bookings": [
    {
      "id": "08c015f8-8945-47e9-bcd1-bf77fc944f25",
      "shopSlug": "harts",
      "serviceId": "haircut",
      "serviceName": "Haircut",
      "staffId": "dana",
      "start": "2026-11-14T14:30:00-05:00",
      "end": "2026-11-14T15:00:00-05:00",
      "display": "Sat 14 Nov, 2:30 pm EST",
      "status": "confirmed",
      "customer": { "displayName": "Maya", "verified": false },
      "agent": { "name": "unknown agent" },
      "depositCents": 1000,
      "createdAt": "2026-11-07T15:25:07.890-05:00"
    }
  ]
}
```

**No sign-in yet:** anyone with the URL can read customer names. Owner sign-in is `TODO(ring-2)`.

## Try the full loop

Start the app. With `DATABASE_URL` set (see [database.md](database.md)), bookings go to Postgres. Without it, they go to an in-memory store that resets when the server restarts. Freezing the clock makes Saturday 14 Nov "the coming Saturday":

```bash
FRONTDESK_NOW=2026-11-07T12:00:00-05:00 pnpm dev
```

Then, with MCP Inspector's CLI:

```bash
I="npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp --transport http"

# 1. What does the shop sell?
$I --method tools/call --tool-name list_services

# 2. When is a haircut free on Saturday?
$I --method tools/call --tool-name get_availability \
  --tool-arg service_id=haircut --tool-arg from=2026-11-14T00:00:00-05:00 --tool-arg to=2026-11-15T00:00:00-05:00

# 3. Book one of the returned starts
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Maya

# 4. The UI's view: the booking is there
curl -s http://localhost:3000/api/shops/harts/bookings

# 5. Same slot again → slot_taken
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Jo
```

After step 3, `get_availability` no longer offers 2:15, 2:30 or 2:45 pm.

## Demo data

The seed ([`supabase/seed.sql`](../supabase/seed.sql)) has one shop, and the in-memory store has the same data:
- Hart's Barbers has one staff member, Dana (`dana`), who works Tue–Sat 9:00–12:00 and 12:30–17:00. The gap is lunch.
- It has three services. A Postgres database starts with no bookings, and so does the in-memory store.

### Freezing time: `FRONTDESK_NOW`

Set `FRONTDESK_NOW` to an RFC 3339 instant to freeze Front Desk's clock. Demos are then reproducible, because "past times" are computed from that instant, and so is the time `book` checks against. `createdAt` still records real time.

```bash
FRONTDESK_NOW=2026-11-07T12:00:00-05:00 pnpm dev
```

On Vercel, set it as an environment variable. Leave it unset to use real time. An invalid value makes `get_availability` and `book` fail with `internal`, and the server log explains why.

## Connecting

### MCP Inspector

```bash
pnpm dev
npx @modelcontextprotocol/inspector
```

In the Inspector UI:
1. Choose transport **Streamable HTTP**.
2. Enter `http://localhost:3000/api/mcp` (or a preview URL plus `/api/mcp`) and click **Connect**.
3. Open **Tools**, then **List Tools**. You should see `list_services`, `get_availability` and `book`.

From the command line:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp --transport http \
  --method tools/call --tool-name get_availability \
  --tool-arg service_id=haircut --tool-arg from=2026-11-14T00:00:00-05:00 --tool-arg to=2026-11-15T00:00:00-05:00
```

### Claude (custom connector)

In Claude: **Settings → Connectors → Add custom connector**.
1. Give it a name such as "Front Desk".
2. Use the URL `https://<your-deployment>/api/mcp`. Claude connects from the internet, so use a deployed or preview URL, not `localhost`.
3. Leave the OAuth fields empty; there's no auth yet.

Then ask, for example: *"What haircut times does Hart's Barbers have this Saturday?"* and then *"Book the 2:30 for Maya."*

Vercel Deployment Protection on preview URLs blocks outside clients like Claude. To test a preview from Claude, use a protection-bypass link, or test on production after merge.

## Not built yet

These are marked `TODO(ring-N)` in the code:

| Ring | Item | Where |
|---|---|---|
| ring-1 | Take deposits (`depositCents` is recorded, not collected) | `lib/server/frontdesk/service.ts` (`book`) |
| ring-1 | Idempotency keys for `book` | `lib/server/frontdesk/service.ts` (`book`) |
| ring-1 | `cancel` and `get_booking` tools | `lib/server/frontdesk/mcp.ts` |
| ring-1 | Owner alerts by email or SMS instead of a log line | `lib/server/notify/log-notifier.ts` |
| ring-1 | Let agents pick the shop | `lib/server/frontdesk/mcp.ts` |
| ring-1 | Lead time, booking horizon, deposit horizon, daylight-saving gaps | `lib/server/engine/availability.ts` |
| ring-2 | Sign-in / caller authentication | `app/api/mcp/route.ts` |
| ring-2 | Verified customer identity (`customer.verified` is always `false`) | `lib/server/frontdesk/service.ts` (`book`) |
| ring-2 | Verified agent identity instead of the self-reported client name | `lib/server/frontdesk/mcp.ts` (`agentNameFrom`) |
| ring-2 | Owner sign-in for the bookings route | `lib/server/frontdesk/service.ts` (`listShopBookings`) |

A UI for any of this is v0's lane.
