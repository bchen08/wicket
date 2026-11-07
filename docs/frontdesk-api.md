# Front Desk agent API (MCP)

Front Desk lets AI agents (Claude, ChatGPT, personal agents) ask a small business what it offers and when it's free. Agents connect over the [Model Context Protocol](https://modelcontextprotocol.io).

| | |
|---|---|
| Endpoint | `<origin>/api/mcp`, e.g. `http://localhost:3000/api/mcp` or `https://<preview>.vercel.app/api/mcp` |
| Transport | Streamable HTTP, stateless (`POST` only; `GET` answers 405) |
| Auth | None yet |
| Shop | One shop for now: Hart's Barbers (`harts`), `America/New_York` |
| Tools | `list_services`, `get_availability`. Both are read-only. |

Request and response shapes are exported from [`lib/types/frontdesk.ts`](../lib/types/frontdesk.ts): `Shop`, `Service`, `Slot`, `ApiError`, `ListServicesResult`, `GetAvailabilityInput`, `GetAvailabilityResult`.

## Conventions

- **Money** is integer cents in `structuredContent` (`3500` = $35.00). The text content shows dollars.
- **Times** are RFC 3339 with an offset, e.g. `2026-11-14T09:00:00-05:00`. Inputs may use any offset, including `Z`. Outputs use the shop's offset.
- **Time zone:** opening hours and `display` strings are in the shop's IANA zone (`America/New_York`).
- **Errors:** the result has `isError: true` and its text is a JSON `ApiError`:

  ```json
  { "error": { "code": "not_found", "message": "…", "next_action": "…", "details": { } } }
  ```

  `code` is `invalid_request`, `not_found` or `internal`. Agents should follow `next_action`.
  A missing required field, or a value of the wrong JSON type (e.g. `"limit": "ten"`), is rejected by the MCP SDK before Front Desk sees it. That error is a plain-text tool error, not the envelope.

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
| `to` | string | Required. RFC 3339 with offset. Exclusive. After `from`, at most 14 days later. |
| `limit` | integer | Optional. 1–50, default 20. |

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

On the coming Saturday the full day (`limit: 50`) has 21 haircut starts. The gaps are 9:45–10:30 (a 10:00–10:45 booking), 11:45–12:15 (the 12:00–12:30 lunch block) and 14:45–15:15 (a 15:00–15:30 booking).

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
- a date without an offset (e.g. `"2026-11-14"`);
- a `limit` outside 1–50.

## Demo data

Shop data is hard-coded until the Postgres slice ([`lib/server/frontdesk/hardcoded-catalog.ts`](../lib/server/frontdesk/hardcoded-catalog.ts)):

- Hart's Barbers has one staff member, `dana`. The shop is open Tue–Sat, 9:00–17:00.
- Lunch is 12:00–12:30 every open day.
- Two example bookings, 10:00–10:45 and 15:00–15:30, are on the **coming Saturday**: the first Saturday strictly after today in New York.

### Freezing time: `FRONTDESK_NOW`

Set `FRONTDESK_NOW` to an RFC 3339 instant to freeze Front Desk's clock. This gives reproducible demos, because "past times" and "the coming Saturday" are then computed from that instant.

```bash
FRONTDESK_NOW=2026-11-07T12:00:00-05:00 pnpm dev
```

On Vercel, set it as an environment variable. Leave it unset to use real time. An invalid value makes `get_availability` fail with `internal`, and the server log explains why.

## Connecting

### MCP Inspector

```bash
pnpm dev
npx @modelcontextprotocol/inspector
```

In the Inspector UI:
1. Choose transport **Streamable HTTP**.
2. Enter `http://localhost:3000/api/mcp` (or a preview URL plus `/api/mcp`) and click **Connect**.
3. Open **Tools**, then **List Tools**.

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

Then ask, for example: *"What haircut times does Hart's Barbers have this Saturday?"*

Vercel Deployment Protection on preview URLs blocks outside clients like Claude. To test a preview from Claude, use a protection-bypass link, or test on production after merge.

## Not built yet

These are marked `TODO(ring-N)` in the code:
- booking;
- a database;
- sign-in;
- deposits;
- lead time;
- booking horizons;
- multi-shop routing;
- daylight-saving gap handling.
