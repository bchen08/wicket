# Front Desk agent API (MCP)

Front Desk lets AI agents (Claude, ChatGPT, personal agents) ask a small business what it offers, what its rules are and when it's free, then book or cancel an appointment. Agents connect over the [Model Context Protocol](https://modelcontextprotocol.io). The UI reads the same data over plain JSON routes, and the owner's console changes it over owner routes.

| | |
|---|---|
| Endpoint | `<origin>/api/mcp`, e.g. `http://localhost:3000/api/mcp` or `https://<preview>.vercel.app/api/mcp` |
| Transport | Streamable HTTP, stateless (`POST` only; `GET` answers 405) |
| Auth | MCP: none yet. Owner routes: `Authorization: Bearer <OWNER_API_TOKEN>` (see [Owner routes](#owner-routes)). |
| Shop | One shop for now: Hart's Barbers (`harts`), `America/New_York` |
| Tools | `list_services`, `get_policies`, `get_availability`, `get_booking` (read-only), `book` and `cancel` |
| Public routes | `GET /api/shops/[shop]/services`, `GET /api/shops/[shop]/bookings` |
| Owner routes | policies, hours, blocked time, services, booking actions and booking history under `/api/shops/[shop]/` |
| Data | Postgres (Supabase). See [database.md](database.md). |

Request and response shapes are exported from [`lib/types/frontdesk.ts`](../lib/types/frontdesk.ts):
- Shared: `Shop`, `Service`, `Slot`, `Policies`, `Booking`, `BookingStatus`, `DepositEffect`, `BookingEvent`, `BookingActor`, `BookingEventType`, `ApiError`, `ApiErrorCode`.
- Tools: `ListServicesResult`, `GetPoliciesResult`, `GetAvailabilityInput`, `GetAvailabilityResult`, `BookInput`, `BookResult`, `GetBookingInput`, `GetBookingResult`, `CancelInput`, `CancelResult` (= `BookingTransitionResult`).
- Public routes: `ServicesResponse`, `BookingsResponse`.
- Owner routes: `PoliciesResponse`, `UpdatePoliciesRequest`, `HoursResponse`, `UpdateHoursRequest`, `WeeklyHours`, `StaffWeeklyHours`, `BlocksResponse`, `CreateBlockRequest`, `BlockResponse`, `BlockedTime`, `CreateServiceRequest`, `UpdateServiceRequest`, `ServiceResponse`, `OwnerBookingActionResponse`, `BookingDetailResponse`.

## Conventions

- **Money** is integer cents in `structuredContent` and JSON (`3500` = $35.00). The text content shows dollars.
- **Times** are RFC 3339 with an offset, e.g. `2026-11-14T09:00:00-05:00`. Inputs may use any offset, including `Z`. Outputs use the shop's offset.
- **Time zone:** opening hours and `display` strings are in the shop's IANA zone (`America/New_York`).
- **Errors:** a tool result has `isError: true` and its text is a JSON `ApiError`. A route answers the same envelope with the HTTP status below.

  ```json
  { "error": { "code": "not_found", "message": "…", "next_action": "…", "details": { } } }
  ```

  Agents should follow `next_action`.
  Every failure uses this envelope, including a missing field and a wrong JSON type (e.g. `"limit": "ten"`). For tools, `details.field` names the offending argument. `"limit": null` is treated as omitted.
  For tools the envelope is in the text, not `structuredContent`. Clients such as MCP Inspector validate `structuredContent` against the tool's `outputSchema` even on errors, so they would reject it there.

### Error codes

The HTTP status applies to the `/api/shops/*` routes. Tools always answer a normal MCP result with `isError: true`.

| `code` | HTTP | When | `details` | `next_action` |
|---|---|---|---|---|
| `invalid_request` | 400 | Bad arguments or body. `book` with an unknown `service_id`. An owner action the booking's status or time doesn't allow. | Tools: `field`, `value`. Owner bodies: `field`, `issues`. Owner actions: `status`, `action`, `booking_id`. | Says what to send instead. |
| `not_found` | 404 | No such shop, service (`get_availability`, `PATCH` service), staff member or blocked time. | What was asked for, plus the valid ids where useful (`valid_service_ids`, `valid_staff_ids`). | Check the slug or id; use one of the valid ids. |
| `slot_taken` | 409 | `book`: a booking is in the way, or another agent won the race for that time and no other staff member is free then. | `start`, `service_id`, `alternatives` (up to 3 nearby `Slot`s, possibly empty) | "Someone just took that time. Call get_availability again and choose another start." When there are alternatives it adds "Nearby open starts you can offer instead are in details.alternatives." |
| `outside_hours` | 422 | `book`: not a bookable start for that service: closed, lunch, blocked time, off the 15-minute grid, or the service would run past closing. | `field: "start"`, `value`, `service_id` | "Call get_availability and choose one of the returned starts." |
| `too_soon` | 422 | `book`: before now + the lead time (rounded up to the grid). This includes the past. | `earliest`, `lead_time_min`, `start` | "Pick a later time: call get_availability from details.earliest." |
| `too_far` | 422 | `book`: at or after the booking horizon for that service. | `latest` (starts must be before it), `horizon_days`, `start` | "Pick an earlier time, before details.latest." |
| `paused` | 409 | `book`: the owner paused bookings. | `phone` (or `null`) | "Tell the person to call the shop at +1 212-555-0142." (without the number if there's none) |
| `booking_not_found` | 404 | `get_booking`, `cancel`, owner booking routes: no booking with that id at this shop. A malformed id or another shop's booking is also not found. | `booking_id` | "Check the booking id. It is the booking.id (a UUID) that book returned." |
| `not_cancellable` | 409 | `cancel`: the booking is already final (cancelled, expired, completed, no-show), or its start has passed. | `status`, `booking_id`, and `start` when it has started | "Don't retry. If the person still needs to change it, tell them to call the shop at +1 212-555-0142." |
| `idempotency_conflict` | 409 | `book` or `cancel`: the `idempotency_key` was already used, within 24 hours, with different arguments. | `idempotency_key`, `tool` | "Use a new idempotency_key (a fresh UUID) for a different request." |
| `unauthorized` | 401 | An owner route without the right bearer token. | none | "Send the header Authorization: Bearer <OWNER_API_TOKEN>." |
| `internal` | 500 (503: owner token not configured) | Our fault: the database is unreachable, `DATABASE_URL` is missing on Vercel, `FRONTDESK_NOW` is invalid. An owner route on a deployment without a usable `OWNER_API_TOKEN` answers 503 with this code. | none | "Retry the same call once. If it fails again, tell the user Front Desk is unavailable right now." (503: set `OWNER_API_TOKEN` and redeploy) |

## `list_services`

Lists the shop and every service it offers. No arguments. Read-only.

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

## `get_policies`

Reads the shop's booking rules. No arguments. Read-only. Agents should call it before booking and tell the person the rules.

| Field (`policies.*`) | Type | Notes |
|---|---|---|
| `leadTimeMin` | integer | Minimum minutes between now and a start. |
| `horizonDays` | integer | How many days ahead a service without a deposit can be booked. |
| `depositHorizonDays` | integer | How many days ahead a service with a deposit can be booked. |
| `cancelWindowHours` | integer | An agent cancelling at least this many hours before the start gets the deposit released. Later, but before the start, the shop keeps it. |
| `paused` | boolean | `true`: the owner paused bookings. `get_availability` returns nothing and `book` returns `paused`. |
| `phone` | string or `null` | The shop's phone number, for people to call. |
| `depositRule`, `lateCancelRule`, `noShowRule` | string | Plain-language rules to read to the person. `""` if not set. |

A shop without a policies row gets the defaults: 120 minutes, 30 days, 6 days, 24 hours, not paused, no phone, empty rules.

**Input**

```json
{}
```

**Text content**

```
Hart's Barbers booking rules (times are in America/New_York):
- Bookings are open.
- Book at least 2 hours ahead.
- Services without a deposit can be booked up to 30 days ahead; services with a deposit up to 6 days ahead.
- Cancelling at least 24 hours before the start releases the deposit; cancelling later, but before the start, means the shop keeps it. After the start, cancel is refused.
- Phone: +1 212-555-0142.
Deposit: Services with a deposit need it when you book. We hold the deposit on your card at booking; it is only charged if you miss the appointment or cancel late.
Late cancellation: Cancel at least 24 hours before your appointment and the deposit is released. Cancel within 24 hours and we keep the deposit as a late-cancellation fee.
No-show: If you don't show up, we keep the deposit. Otherwise it is released after your appointment.
Read these rules to the person before booking. No money is collected yet: nothing is held, charged or refunded.
```

While paused, the second line reads `- Bookings are PAUSED: Hart's Barbers isn't taking bookings right now. Don't book. Tell the person to call the shop at +1 212-555-0142.`

**`structuredContent`** (`GetPoliciesResult`)

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "policies": {
    "leadTimeMin": 120,
    "horizonDays": 30,
    "depositHorizonDays": 6,
    "cancelWindowHours": 24,
    "paused": false,
    "phone": "+1 212-555-0142",
    "depositRule": "Services with a deposit need it when you book. We hold the deposit on your card at booking; it is only charged if you miss the appointment or cancel late.",
    "lateCancelRule": "Cancel at least 24 hours before your appointment and the deposit is released. Cancel within 24 hours and we keep the deposit as a late-cancellation fee.",
    "noShowRule": "If you don't show up, we keep the deposit. Otherwise it is released after your appointment."
  }
}
```

**Errors:** `internal`: retry once.

## `get_availability`

Returns open start times for one service in a window. Read-only: it doesn't hold anything.

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
- **Hours.** Starts are on a 15-minute grid from opening time, and the whole appointment must end by closing time.
- **Busy time.** A start is dropped if `[start, start + duration)` overlaps any busy time: an existing booking (`awaiting_deposit` or `confirmed`) or a blocked time (a holiday or time off). Busy times are half-open, so a slot can end exactly when a booking starts.
- **Lead time.** Nothing starts before now + `leadTimeMin`, rounded **up** to the shop's local 15-minute grid. With Hart's 2 hours, at 10:05 the earliest start is 12:15. So past times are never returned.
- **Horizon.** Starts must be before now + `horizonDays` (30 for Hart's), counted in calendar days in the shop's zone, so the bound keeps its local time across a clock change. For a service with a deposit (`depositCents > 0`) the bound is `depositHorizonDays` (6) instead. The deposit will be held on the customer's card at booking (Ring 1c), and a card hold lasts about a week, so those services can't be booked further ahead than the hold would last.
- **Paused.** While the owner has paused bookings, the result is `{ "slots": [], "truncated": false }` and the text says to call the shop.
- **Daylight saving.** Opening and closing times are local. A local time that doesn't exist (the spring gap) moves forward to the instant the gap ends, so hours opening at 02:30 on the spring-forward day open at 3:00 am EDT. A repeated local time (the autumn overlap) means its first occurrence. Starts step in elapsed time, so hours that span the change get no starts in the missing hour, and the repeated hour's starts appear twice, once per offset ("1:00 am EDT", then "1:00 am EST"). Hart's hours (9:00–17:00) never meet a clock change.
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

Examples with the clock frozen at Tue 10 Nov 2026, 10:00 am (see [Try the full loop](#try-the-full-loop)):
- With no bookings, a full Saturday 14 Nov (`limit: 50`) has 28 haircut starts: 9:00–11:30 and 12:30–16:30. There's no 11:45 start, because a 30-minute haircut then would run into lunch. Every booking removes the starts that would overlap it.
- Tuesday 10 Nov itself has 17 haircut starts, 12:30–16:30: nothing before 12:00 (the 2-hour lead time), and 12:00 is lunch.
- A haircut on Tue 17 Nov has no starts: it's beyond the 6-day deposit horizon (starts must be before Mon 16 Nov, 10:00 am). A beard trim (no deposit) that day does.

When nothing is free (and the shop isn't paused), the text is:

```
No open times for haircut in that window. Try a later or wider window (up to 14 days). Starts inside the shop's lead time or beyond how far ahead it books are never offered (see get_policies).
```

While paused:

```
Hart's Barbers isn't taking bookings right now, so there are no open times. Tell the person to call the shop at +1 212-555-0142.
```

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

Books an appointment. **It's confirmed as soon as the call returns**: there's no hold-then-confirm step, so call it only once the user has picked a time and heard the shop's rules (`get_policies`).

- `start` must be one of the starts `get_availability` just returned for the same service. Any other time is refused with the most specific code (see Errors).
- **`idempotency_key` is required.** Send a fresh UUID per intended booking. Reuse it only to retry the same call, e.g. after a timeout. See [Idempotency](#idempotency).
- **No deposit is collected yet.** `depositCents` is the deposit the service required when it was booked; it will be collected once deposits are enabled.
- **The customer is not verified.** `customer.verified` is always `false`.
- `agent.name` is a best-effort, unverified label: the MCP client's self-reported name, with control characters removed and cut to 80 characters. Clients on the 2026-07-28 protocol send it with every request. Stateless 2025-era requests don't, so those bookings show `"unknown agent"`. MCP Inspector is one of these.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` (the same arguments, key included, have no additional effect), `openWorldHint: false`.

| Field | Type | Notes |
|---|---|---|
| `service_id` | string | Required. An `id` from `list_services`. |
| `start` | string | Required. A slot `start` from `get_availability`, RFC 3339 with offset. Any offset is accepted if it's the same instant. |
| `customer_name` | string | Required. 1–80 characters after trimming, without the NUL character (U+0000). The name the booking is under. |
| `idempotency_key` | string | Required. 8–128 visible ASCII characters, no spaces. A UUID. |

**Input**

```json
{
  "service_id": "haircut",
  "start": "2026-11-14T14:30:00-05:00",
  "customer_name": "Maya",
  "idempotency_key": "4b1f6f0e-2a59-4a8e-9a3c-6d2f1b7c9e01"
}
```

**Text content**

```
Booked Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. A $10 deposit will be required once deposits are enabled; nothing was charged.
Booking id: 632aa35c-4e9e-4a08-8880-b5b1165939e2. It is confirmed now; don't book it again.
```

A replay (same key, same arguments) returns the same booking and adds a line:

```
Booked Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. A $10 deposit will be required once deposits are enabled; nothing was charged.
(replayed: this is the booking from your earlier call with the same idempotency_key)
Booking id: 632aa35c-4e9e-4a08-8880-b5b1165939e2. It is confirmed now; don't book it again.
```

**`structuredContent`** (`BookResult`)

```json
{
  "booking": {
    "id": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
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
    "createdAt": "2026-11-10T10:00:00-05:00"
  }
}
```

This example ran on the in-memory store with the clock frozen at Tue 10 Nov, 10:00 am. With Postgres, `createdAt` is the database's real time.

**How it decides:**
1. It checks the arguments (`invalid_request`).
2. It looks up the `idempotency_key`. The same key with the same arguments returns the stored booking without doing anything else; the same key with other arguments is `idempotency_conflict`.
3. It checks `start` against the shop's rules, using the current clock, in this order: `paused`, then `too_soon` (lead time), then `too_far` (horizon). These don't read any bookings, so a start in year 1 or year 9999 is simply `too_soon` or `too_far`. Then against hours and busy time: if a booking is in the way it's `slot_taken`, otherwise `outside_hours` (closed, lunch, blocked time, off the grid, or running past closing). The staff member comes from the free slot.
4. It stores the booking and its `booked` event in one transaction (in Postgres, the same transaction as the idempotency key). The database's `no_overlap` constraint has the final word, so two agents racing for the same staff member and time can't both win. The loser reads busy time again: if another staff member is free at exactly that start, it books them instead (once). Otherwise, or if that insert loses too, it gets `slot_taken` with alternatives.
5. It notifies the owner, only for a new booking (not a replay). In Ring 1a that's one JSON log line, `booking.created`, with the customer's first name only. A notifier failure never fails the booking.

### Idempotency

`book` and `cancel` take a required `idempotency_key`: 8–128 visible ASCII characters with no spaces. Send a fresh UUID per intended action.

- **Same key, same arguments** (within 24 hours): you get the first call's result again, with `(replayed: …)` in the text. Nothing is booked or cancelled twice, no second event is written, and the owner isn't alerted again.
  - "Same arguments" is normalized. For `book`: the same `service_id`, the same instant for `start` (any offset), and the same `customer_name` after trimming. For `cancel`: the same `booking_id` (a UUID in either case).
  - A replay is the first response as it was. It doesn't re-check the rules or show later changes; call `get_booking` for the current status.
- **Same key, different arguments** (within 24 hours): `idempotency_conflict`.
- **A call that fails isn't remembered.** Retrying with the same key runs it again.
- Keys are per tool: the same key can be used once for `book` and once for `cancel`.
- Two concurrent calls with the same key run one after the other. The second gets the first's result, or runs itself if the first failed.
- After 24 hours a key counts as new and may be reused. With Postgres the age is measured on the database's clock, even when `FRONTDESK_NOW` freezes Front Desk's clock (see [database.md](database.md)). Old keys aren't deleted yet: `TODO(ring-2)`.

**Errors**

| `code` | When | `details` | `next_action` |
|---|---|---|---|
| `slot_taken` | A booking is already there. This covers booking the same slot twice, an overlapping service (e.g. a 45-min haircut-beard at 9:45 when 10:00 is booked), and losing a race to another agent when no other staff member is free at that start (or the one retry with them loses too). | `start`, `service_id`, `alternatives`: up to 3 free starts within 24 hours either side, closest first (listed earliest first), under the same rules. They include `start` itself if some staff member is still free then. | "Someone just took that time. Call get_availability again and choose another start." plus, when there are alternatives, "Nearby open starts you can offer instead are in details.alternatives." |
| `too_soon` | `start` is before now + the lead time, rounded up to the grid (or in the past). | `earliest`, `lead_time_min`, `start` | "Pick a later time: call get_availability from details.earliest." |
| `too_far` | `start` is at or after the horizon: 6 days ahead for a service with a deposit, 30 days otherwise. | `latest`, `horizon_days`, `start` | "Pick an earlier time, before details.latest." |
| `outside_hours` | `start` isn't a bookable time for that service: off the 15-minute grid, outside opening hours (including lunch, 12:00–12:30), on a closed day, on blocked time, or the service would run past closing. | `field: "start"`, `value`, `service_id` | "Call get_availability and choose one of the returned starts." |
| `paused` | The owner paused bookings. | `phone` | "Tell the person to call the shop at +1 212-555-0142." |
| `idempotency_conflict` | The key was already used with different arguments. | `idempotency_key`, `tool: "book"` | "Use a new idempotency_key (a fresh UUID) for a different request." |
| `invalid_request` | Unknown `service_id`. | `field`, `value`, `valid_service_ids` | Call `list_services`, then `get_availability`. |
| `invalid_request` | `start` isn't RFC 3339 with an offset; `customer_name` is missing, blank, over 80 characters or contains the NUL character (U+0000); `idempotency_key` is missing, too short, too long or has spaces; a field is missing or the wrong JSON type. | `field`, `value` | Says what to send instead. |

```json
{
  "error": {
    "code": "slot_taken",
    "message": "That time is already booked.",
    "next_action": "Someone just took that time. Call get_availability again and choose another start. Nearby open starts you can offer instead are in details.alternatives.",
    "details": {
      "start": "2026-11-14T14:30:00-05:00",
      "service_id": "haircut",
      "alternatives": [
        { "start": "2026-11-14T13:45:00-05:00", "end": "2026-11-14T14:15:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 1:45 pm EST" },
        { "start": "2026-11-14T14:00:00-05:00", "end": "2026-11-14T14:30:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 2:00 pm EST" },
        { "start": "2026-11-14T15:00:00-05:00", "end": "2026-11-14T15:30:00-05:00", "staffId": "dana", "display": "Sat 14 Nov, 3:00 pm EST" }
      ]
    }
  }
}
```

```json
{
  "error": {
    "code": "too_soon",
    "message": "Hart's Barbers needs at least 2 hours notice; the earliest start is Tue 10 Nov, 12:00 pm EST.",
    "next_action": "Pick a later time: call get_availability from details.earliest.",
    "details": { "earliest": "2026-11-10T12:00:00-05:00", "lead_time_min": 120, "start": "2026-11-10T11:00:00-05:00" }
  }
}
```

```json
{
  "error": {
    "code": "too_far",
    "message": "Hart's Barbers takes bookings for Haircut up to 6 days ahead.",
    "next_action": "Pick an earlier time, before details.latest.",
    "details": { "latest": "2026-11-16T10:00:00-05:00", "horizon_days": 6, "start": "2026-11-17T10:00:00-05:00" }
  }
}
```

```json
{
  "error": {
    "code": "paused",
    "message": "Hart's Barbers isn't taking bookings right now.",
    "next_action": "Tell the person to call the shop at +1 212-555-0142.",
    "details": { "phone": "+1 212-555-0142" }
  }
}
```

## `get_booking`

Reads one booking by its id. Read-only.

**Until customer consent ships, anyone holding a booking id can read it** (`TODO(ring-1b)`). The tool's description says so.

| Field | Type | Notes |
|---|---|---|
| `booking_id` | string | Required. The `booking.id` (a UUID) that `book` returned. |

**Input**

```json
{ "booking_id": "632aa35c-4e9e-4a08-8880-b5b1165939e2" }
```

**Text content**

```
Haircut, Sat 14 Nov, 2:30 pm EST, for Maya. Status: confirmed.
Deposit: $10 (not collected yet). Booking id: 632aa35c-4e9e-4a08-8880-b5b1165939e2.
```

A service without a deposit says `No deposit.` instead.

**`structuredContent`** (`GetBookingResult`): `{ "booking": Booking }`, the same `Booking` shape `book` returns, with its current `status`.

**Errors**

| `code` | When | `details` |
|---|---|---|
| `booking_not_found` | No booking with that id at this shop. A malformed id is not found too. | `booking_id` |
| `invalid_request` | `booking_id` is missing, blank or not a string. | `field`, `value` |

```json
{
  "error": {
    "code": "booking_not_found",
    "message": "No booking with id \"6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c\" at this shop.",
    "next_action": "Check the booking id. It is the booking.id (a UUID) that book returned.",
    "details": { "booking_id": "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c" }
  }
}
```

## `cancel`

Cancels a booking under the shop's cancellation policy (see [The booking lifecycle](#the-booking-lifecycle)):
- at least `cancelWindowHours` (24 for Hart's) before the start → `cancelled`, deposit `released`;
- later, but before the start → `cancelled`, deposit `captured` (the shop keeps it as a late fee);
- at or after the start, or from a final status → `not_cancellable`.

The agent should tell the person the consequence and get their go-ahead first.

- **Nothing is collected yet.** `depositEffect` is what the policy decides; `depositCollected` is always `false` until Ring 1c.
- **`idempotency_key` is required**, as for `book`. A retry with the same key and `booking_id` returns the first result without cancelling twice. See [Idempotency](#idempotency).
- **Until customer consent ships, anyone holding a booking id can cancel it** (`TODO(ring-1b)`). The tool's description says so.
- The owner isn't alerted about agent cancellations yet (`TODO(ring-1c)`).
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`.

| Field | Type | Notes |
|---|---|---|
| `booking_id` | string | Required. The `booking.id` (a UUID) that `book` returned. |
| `idempotency_key` | string | Required. 8–128 visible ASCII characters, no spaces. A fresh UUID per intended cancellation. |

**Input**

```json
{ "booking_id": "632aa35c-4e9e-4a08-8880-b5b1165939e2", "idempotency_key": "9e2d7c1a-5b3f-4e6d-8c9b-0a1f2e3d4c5b" }
```

**Text content** (more than 24 hours ahead)

```
Cancelled Haircut, Sat 14 Nov, 2:30 pm EST, for Maya. Status: cancelled.
Under the shop's policy the $10 deposit is released: the customer keeps it. No money has been collected yet, so nothing was charged or refunded.
Booking id: 632aa35c-4e9e-4a08-8880-b5b1165939e2.
```

The middle line depends on `depositEffect`:
- `captured`: `Under the shop's policy the shop keeps the $10 deposit as a late-cancellation fee. No money has been collected yet, so nothing was charged or refunded.`
- `none`: `This booking has no deposit, so there's nothing to release or keep. No money has been collected yet, so nothing was charged or refunded.`

A replay adds `(replayed: this is the result of your earlier cancel with the same idempotency_key)` after the first line.

**`structuredContent`** (`CancelResult`)

```json
{
  "booking": {
    "id": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
    "shopSlug": "harts",
    "serviceId": "haircut",
    "serviceName": "Haircut",
    "staffId": "dana",
    "start": "2026-11-14T14:30:00-05:00",
    "end": "2026-11-14T15:00:00-05:00",
    "display": "Sat 14 Nov, 2:30 pm EST",
    "status": "cancelled",
    "customer": { "displayName": "Maya", "verified": false },
    "agent": { "name": "unknown agent" },
    "depositCents": 1000,
    "createdAt": "2026-11-10T10:00:00-05:00"
  },
  "depositEffect": "released",
  "depositCollected": false
}
```

A cancelled booking frees its time: `get_availability` offers it again.

**Errors**

| `code` | When | `details` | `next_action` |
|---|---|---|---|
| `not_cancellable` | The booking is already final (cancelled, expired, completed or no-show), or its start has passed. | `status`, `booking_id`, plus `start` when it has started | "Don't retry. If the person still needs to change it, tell them to call the shop at +1 212-555-0142." |
| `booking_not_found` | No booking with that id at this shop. | `booking_id` | "Check the booking id. It is the booking.id (a UUID) that book returned." |
| `idempotency_conflict` | The key was already used to cancel a different booking. | `idempotency_key`, `tool: "cancel"` | "Use a new idempotency_key (a fresh UUID) for a different request." |
| `invalid_request` | `booking_id` or `idempotency_key` is missing or malformed. | `field`, `value` | Says what to send instead. |

```json
{
  "error": {
    "code": "not_cancellable",
    "message": "This booking is already cancelled.",
    "next_action": "Don't retry. If the person still needs to change it, tell them to call the shop at +1 212-555-0142.",
    "details": { "status": "cancelled", "booking_id": "632aa35c-4e9e-4a08-8880-b5b1165939e2" }
  }
}
```

## The booking lifecycle

| `status` | Meaning | Holds the time? |
|---|---|---|
| `awaiting_deposit` | Holds the slot until the deposit is paid. Not produced until Ring 1c. | Yes |
| `confirmed` | The appointment is on. `book` creates bookings in this status. | Yes |
| `cancelled` | Cancelled by the agent or the owner. | No (final) |
| `expired` | The deposit wasn't paid in time. Not produced until Ring 1c. | No (final) |
| `completed` | The owner marked it done, after the start. | No (final) |
| `no_show` | The owner marked that the customer didn't come, after the start. | No (final) |

Only `awaiting_deposit` and `confirmed` count as busy time, and only they are covered by the database's `no_overlap` constraint. A final status never changes again.

### Transitions

One pure function, `decide()` in [`lib/server/engine/lifecycle.ts`](../lib/server/engine/lifecycle.ts), decides every change. "Before the start" means now < start; "after the start" means now ≥ start, so an appointment starting right now has started.

| Who | Action | From | When | Result | `depositEffect` |
|---|---|---|---|---|---|
| agent | `cancel` tool | `confirmed` | start − now ≥ `cancelWindowHours` | `cancelled` | `released` |
| agent | `cancel` tool | `confirmed` | before the start, inside the window | `cancelled` | `captured` |
| agent | `cancel` tool | `confirmed` | after the start | `not_cancellable` | |
| agent | `cancel` tool | `awaiting_deposit` | any time | `cancelled` | `released` |
| agent | `cancel` tool | a final status | any time | `not_cancellable` | |
| owner | `POST …/cancel` | `awaiting_deposit` or `confirmed` | before the start | `cancelled` | `released` |
| owner | `POST …/cancel` | `awaiting_deposit` or `confirmed` | after the start | `invalid_request` | |
| owner | `POST …/complete` | `confirmed` | after the start | `completed` | `released` |
| owner | `POST …/no-show` | `confirmed` | after the start | `no_show` | `captured` |
| owner | complete or no-show | `confirmed` | before the start | `invalid_request` | |
| owner | complete or no-show | `awaiting_deposit` | any time | `invalid_request` | |
| owner | any | a final status | any time | `invalid_request` | |

- A booking with `depositCents: 0` always gets `depositEffect: "none"` instead of `released` or `captured`.
- **No money moves yet.** Every result and event says `depositCollected: false`. `TODO(ring-1c)`: hold, release and capture real deposits.
- **Transitions are atomic.** The store changes the booking only if its status is still the one `decide()` saw (`UPDATE … WHERE status = <expected>`), and writes the event in the same statement. Of two concurrent transitions only one wins; the loser re-reads the booking and gets the right error (e.g. `not_cancellable`).

### Events

Every state change writes exactly one event, in the same transaction, starting with the booking itself. `GET /api/shops/[shop]/bookings/[id]` lists them, oldest first.

| Field | Notes |
|---|---|
| `id` | Increasing id, as a string. Events sort by `at`, then `id`. |
| `bookingId` | The booking. |
| `at` | RFC 3339 in the shop's offset. With Postgres, the database's time (see [Freezing time](#freezing-time-frontdesk_now)). |
| `actor` | `agent`, `owner`, or `system` (automatic changes, from Ring 1c). |
| `type` | `booked`, `cancelled`, `completed` or `no_show`. Ring 1b/1c add more. |
| `data` | `booked`: `{ status, agentName }`. A transition: `{ from, to, depositEffect, depositCollected }`. |

```json
[
  {
    "id": "1",
    "bookingId": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
    "at": "2026-11-10T10:00:00-05:00",
    "actor": "agent",
    "type": "booked",
    "data": { "status": "confirmed", "agentName": "unknown agent" }
  },
  {
    "id": "2",
    "bookingId": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
    "at": "2026-11-10T10:00:00-05:00",
    "actor": "agent",
    "type": "cancelled",
    "data": { "from": "confirmed", "to": "cancelled", "depositEffect": "released", "depositCollected": false }
  }
]
```

The database also stamps `cancelled_at` and `cancelled_by`, `completed_at` or `no_show_at` on the booking row. `Booking` doesn't show them; the events do.

## HTTP routes

Plain JSON, request-time only (never cached; `Cache-Control: no-store`). Types are in `lib/types/frontdesk.ts`. Failures use the `ApiError` envelope with the status from the [error codes](#error-codes) table. An unknown shop returns **404**:

```json
{ "error": { "code": "not_found", "message": "No shop with slug \"nope\".", "next_action": "Check the shop slug. Front Desk currently serves one shop: harts.", "details": { "shop": "nope" } } }
```

Unexpected failures return **500** with `code: "internal"`.

### `GET /api/shops/[shop]/services` → `ServicesResponse`

Public: no token.

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

Public: no token. Bookings of any status whose time overlaps the range from 7 days ago to 30 days ahead, sorted by `start`. Each item is a `Booking`, the same shape `book` returns.

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "bookings": [
    {
      "id": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
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
      "createdAt": "2026-11-10T10:00:00-05:00"
    }
  ]
}
```

**No sign-in yet:** anyone with the URL can read customer names. Owner sign-in is `TODO(ring-2)`.

## Owner routes

The owner's console (v0) uses these to change the shop's rules and act on bookings.

**Auth (stub).** Every owner route needs the header `Authorization: Bearer <OWNER_API_TOKEN>`, or the `fd_owner` cookie from an [owner session](#owner-session-stub) (that's how the console calls them from the browser). `TODO(ring-2): owner sign-in replaces the token.`
- No header, another scheme, an empty token or the wrong token, and no valid session cookie → **401** `unauthorized`, with `WWW-Authenticate: Bearer realm="front-desk-owner"`.
- **Never open.** If the deployment's `OWNER_API_TOKEN` is unset, blank, or shorter than 16 characters (after trimming), every owner route answers **503** with `code: "internal"` and a configuration message. Setting it up is in [database.md](database.md#4-set-owner_api_token).
- The token is checked first, before the request touches the database. It's compared in constant time, read from the environment on every request, and never logged or echoed.

```json
{ "error": { "code": "unauthorized", "message": "Missing or invalid owner token.", "next_action": "Send the header Authorization: Bearer <OWNER_API_TOKEN>." } }
```

```json
{ "error": { "code": "internal", "message": "The owner API is not configured on this deployment: OWNER_API_TOKEN is not set.", "next_action": "Set OWNER_API_TOKEN (at least 16 random characters) in the deployment's environment variables, then redeploy." } }
```

### Owner session (stub)

So the console never keeps `OWNER_API_TOKEN` in page code: the owner types the token once, the server checks it and answers with an HttpOnly cookie, and every owner route accepts that cookie. `TODO(ring-2): owner sign-in by texted code replaces this; GET /api/shops/[shop]/bookings moves behind owner auth then.`

| Method and path | Request | Response | Success |
|---|---|---|---|
| `POST /api/owner/session` | `OwnerSessionRequest` `{ "token": "…" }` | `OwnerSessionResponse` `{ "signedIn": true, "expiresAt": "…" }`, plus `Set-Cookie: fd_owner=…` | 200 |
| `GET /api/owner/session` | | `OwnerSessionResponse`: `{ "signedIn": true, "expiresAt": "2026-11-08T10:00:00Z" }` or `{ "signedIn": false }` | 200 |
| `DELETE /api/owner/session` | | `OwnerSessionResponse` `{ "signedIn": false }`, plus a `Set-Cookie` that clears `fd_owner` | 200 |

**`POST`** checks `token` against `OWNER_API_TOKEN` exactly like the bearer check (trimmed, constant time):
- The right token → 200 and the cookie `fd_owner=<expiry>.<signature>; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict; Secure`. `Secure` is left off only on `http://localhost` (and `127.0.0.1`, `[::1]`), so `pnpm dev` works in every browser.
- The value is the expiry (Unix seconds) and an HMAC-SHA256 of `owner:<expiry>` keyed with `OWNER_API_TOKEN`. The token itself is never in the cookie, and changing the token ends every session. A session lasts 12 hours on the server's wall clock (`FRONTDESK_NOW` doesn't affect it).
- The wrong token → **401** `unauthorized` (`"Wrong owner token."`), no cookie. A body that isn't `{ "token": "<string>" }` → **400** `invalid_request` with `details.field`. Token not configured → **503**, as on every owner route.
- **Rate limit:** 10 attempts per IP per 15 minutes, counting every attempt (right or wrong). The 11th → **429** with a `Retry-After` header (seconds), `code: "invalid_request"` and `details.retryAfter`. The counts are in memory, per server instance: on Vercel each instance counts separately and a cold start resets them, so treat it as a speed bump, not a guarantee. The IP is the first `X-Forwarded-For` address, which Vercel sets.

**`GET`** tells the console whether to show the unlock screen: `signedIn` is true only for a valid, unexpired cookie signed with the current token. Token not configured → **503**, so the console can say so instead of offering a sign-in that can't work.

**`DELETE`** signs out: it always answers 200 and clears the cookie. It needs no auth.

**Using the cookie on owner routes.** `GET` and `HEAD` need only the cookie. Any other method (`PUT`, `POST`, `PATCH`, `DELETE`) authenticated by the cookie must also carry an `Origin` header equal to the request's own origin (scheme, host and port), which a browser adds on its own to `fetch` from the console. The server takes its own origin from `X-Forwarded-Proto` and `X-Forwarded-Host` (or `Host`), which Next.js fills in and Vercel overwrites, not from `request.url`: Next.js builds that from the server's own hostname and port. A missing or different `Origin` → **403** `invalid_request`, before the request touches the database. This is the CSRF guard, on top of `SameSite=Strict`. Requests with the right bearer token skip it.

```json
{ "error": { "code": "invalid_request", "message": "Refused a write signed in with the owner session cookie: the Origin header is missing or isn't this site.", "next_action": "Send it from the Front Desk console on this site (the browser adds the matching Origin header), or authenticate with Authorization: Bearer <OWNER_API_TOKEN> instead of the cookie." } }
```

From the console (same origin, so the browser sends and stores the cookie by itself):

```ts
import type { OwnerSessionRequest, OwnerSessionResponse } from "@/lib/types/frontdesk";

const json = { "Content-Type": "application/json" };

// On load: unlocked already?
const session = (await (await fetch("/api/owner/session")).json()) as OwnerSessionResponse;
// Unlock: 200 sets the cookie; 401 wrong token; 429 wait Retry-After seconds.
await fetch("/api/owner/session", { method: "POST", headers: json, body: JSON.stringify({ token } satisfies OwnerSessionRequest) });
// Owner routes: the browser sends the cookie, and the Origin header on writes.
await fetch("/api/shops/harts/policies", { method: "PUT", headers: json, body: JSON.stringify({ paused: true }) });
// Sign out.
await fetch("/api/owner/session", { method: "DELETE" });
```

With curl:

```bash
curl -s -c jar.txt -X POST http://localhost:3000/api/owner/session \
  -H "Content-Type: application/json" -d "{\"token\":\"$OWNER_API_TOKEN\"}"
curl -s -b jar.txt http://localhost:3000/api/owner/session
curl -s -b jar.txt http://localhost:3000/api/shops/harts/policies
# A write with the cookie needs the matching Origin:
curl -s -b jar.txt -X PUT http://localhost:3000/api/shops/harts/policies \
  -H "Origin: http://localhost:3000" -H "Content-Type: application/json" -d '{"paused":false}'
curl -s -b jar.txt -c jar.txt -X DELETE http://localhost:3000/api/owner/session
```

### Routes

| Method and path | Request | Response | Success |
|---|---|---|---|
| `GET /api/shops/[shop]/policies` | | `PoliciesResponse` | 200 |
| `PUT /api/shops/[shop]/policies` | `UpdatePoliciesRequest` | `PoliciesResponse` | 200 |
| `GET /api/shops/[shop]/hours` | | `HoursResponse` | 200 |
| `PUT /api/shops/[shop]/hours` | `UpdateHoursRequest` | `HoursResponse` | 200 |
| `GET /api/shops/[shop]/blocks?from=&to=` | | `BlocksResponse` | 200 |
| `POST /api/shops/[shop]/blocks` | `CreateBlockRequest` | `BlockResponse` | 201 |
| `DELETE /api/shops/[shop]/blocks?id=<uuid>` | | `BlockResponse` (the deleted block) | 200 |
| `POST /api/shops/[shop]/services` | `CreateServiceRequest` | `ServiceResponse` | 201 |
| `PATCH /api/shops/[shop]/services/[id]` | `UpdateServiceRequest` | `ServiceResponse` | 200 |
| `POST /api/shops/[shop]/bookings/[id]/cancel` | no body | `OwnerBookingActionResponse` | 200 |
| `POST /api/shops/[shop]/bookings/[id]/complete` | no body | `OwnerBookingActionResponse` | 200 |
| `POST /api/shops/[shop]/bookings/[id]/no-show` | no body | `OwnerBookingActionResponse` | 200 |
| `GET /api/shops/[shop]/bookings/[id]` | | `BookingDetailResponse` | 200 |

Other statuses: **400** `invalid_request`, **401** `unauthorized`, **403** `invalid_request` (a write with the session cookie from another origin), **404** `not_found` (shop, staff member, service, blocked time) or `booking_not_found`, **500** `internal`, **503** not configured.

**Validation.** Request bodies are checked with zod:
- The body must be a JSON object. An empty body or invalid JSON is 400 with `details.field: "body"`.
- Unknown fields are rejected.
- Text can't contain the NUL character (U+0000), which Postgres can't store: `phone`, the three rules, a service's `id` and `name`, a block's `reason`, and `staffId`. A shop slug, service id or booking id in the path that contains it is simply 404.
- A failure is 400 `invalid_request`. The message is the first problem; `details.field` is its dot path (e.g. `weekly.1.close`, or `body` for the body as a whole); `details.issues` lists every problem as `{ path, message }`.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "leadTimeMin must be a whole number of minutes from 0 to 10080.",
    "next_action": "Fix the field named in details.field, then send the PUT again with only the fields to change.",
    "details": {
      "field": "leadTimeMin",
      "issues": [
        { "path": "leadTimeMin", "message": "leadTimeMin must be a whole number of minutes from 0 to 10080." },
        { "path": "color", "message": "Unknown field \"color\"." }
      ]
    }
  }
}
```

The examples below assume `export OWNER_API_TOKEN=<the deployment's token>`.

### Policies

`GET` returns the shop and its policies (`PoliciesResponse`, the same shape as `get_policies`). `PUT` changes some of them.

`PUT` body (`UpdatePoliciesRequest`): send only the fields to change, at least one. The others keep their values. Changes apply to the next tool call.

| Field | Allowed |
|---|---|
| `leadTimeMin` | Whole number, 0–10080 (7 days) |
| `horizonDays` | Whole number, 1–365 |
| `depositHorizonDays` | Whole number, 1–365 |
| `cancelWindowHours` | Whole number, 0–720 (30 days) |
| `paused` | `true` or `false` |
| `phone` | 1–40 characters, or `null` to remove it |
| `depositRule`, `lateCancelRule`, `noShowRule` | At most 1000 characters; `""` clears it |

Text is stored trimmed. A shop without a policies row gets one, starting from the defaults. The change is merged into the stored row in one step, so two `PUT`s of different fields at the same moment both take effect.

```bash
curl -s http://localhost:3000/api/shops/harts/policies -H "Authorization: Bearer $OWNER_API_TOKEN"

# Pause bookings: get_availability returns nothing and book returns paused
curl -s -X PUT http://localhost:3000/api/shops/harts/policies \
  -H "Authorization: Bearer $OWNER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"paused": true}'
```

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "policies": {
    "leadTimeMin": 120,
    "horizonDays": 30,
    "depositHorizonDays": 6,
    "cancelWindowHours": 24,
    "paused": true,
    "phone": "+1 212-555-0142",
    "depositRule": "Services with a deposit need it when you book. We hold the deposit on your card at booking; it is only charged if you miss the appointment or cancel late.",
    "lateCancelRule": "Cancel at least 24 hours before your appointment and the deposit is released. Cancel within 24 hours and we keep the deposit as a late-cancellation fee.",
    "noShowRule": "If you don't show up, we keep the deposit. Otherwise it is released after your appointment."
  }
}
```

### Hours

`GET` returns every staff member's regular week (`HoursResponse`), each sorted by weekday, then `open`:

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "staff": [
    {
      "staffId": "dana",
      "staffName": "Dana",
      "weekly": [
        { "weekday": 2, "open": "09:00", "close": "12:00" },
        { "weekday": 2, "open": "12:30", "close": "17:00" },
        { "weekday": 3, "open": "09:00", "close": "12:00" },
        { "weekday": 3, "open": "12:30", "close": "17:00" },
        { "weekday": 4, "open": "09:00", "close": "12:00" },
        { "weekday": 4, "open": "12:30", "close": "17:00" },
        { "weekday": 5, "open": "09:00", "close": "12:00" },
        { "weekday": 5, "open": "12:30", "close": "17:00" },
        { "weekday": 6, "open": "09:00", "close": "12:00" },
        { "weekday": 6, "open": "12:30", "close": "17:00" }
      ]
    }
  ]
}
```

`PUT` (`UpdateHoursRequest`) replaces **one** staff member's whole week and returns everyone's week:
- `staffId`: one of the shop's staff. Unknown → 404 `not_found` with `details.valid_staff_ids`.
- `weekly`: at most 50 windows `{ weekday, open, close }`. `weekday` is ISO, 1 (Monday) to 7 (Sunday). `open` and `close` are 24-hour `"HH:mm"` on the 15-minute grid (minutes 00, 15, 30 or 45), in the shop's local time, with `open` before `close`.
- Windows on the same weekday may touch but not overlap. A break such as lunch is the gap between two windows.
- `[]` means the staff member never works.
- Existing bookings are not touched.

```bash
# Dana: Tuesdays as before, Saturdays 9:00–13:00, no other days
curl -s -X PUT http://localhost:3000/api/shops/harts/hours \
  -H "Authorization: Bearer $OWNER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"staffId":"dana","weekly":[{"weekday":2,"open":"09:00","close":"12:00"},{"weekday":2,"open":"12:30","close":"17:00"},{"weekday":6,"open":"09:00","close":"13:00"}]}'
```

### Blocked time

Holidays and time off. A blocked time is half-open, `[start, end)`. While it lasts, `get_availability` offers no starts that would overlap it, and `book` there returns `outside_hours`.

- `GET ?from=&to=`: blocks overlapping `[from, to)`, sorted by start (`BlocksResponse`). Both are optional RFC 3339 instants from `2000-01-01T00:00:00Z` to `2999-12-31T23:59:59Z`. The default is 7 days ago to 366 days ahead. `from` must be before `to`.
- `POST` (`CreateBlockRequest`) → **201** `BlockResponse`:
  - `staffId`: one of the shop's staff (else 404 `not_found`);
  - `start`, `end`: RFC 3339 with an offset, from `2000-01-01T00:00:00Z` to `2999-12-31T23:59:59Z`; `start` before `end`; at most 366 days long;
  - `reason`: optional, at most 200 characters, default `""`. It's for the owner and never shown to agents.
  - Existing bookings inside the block are not touched. Cancel them separately if needed.
- `DELETE ?id=<uuid>` → the deleted block (`BlockResponse`). A missing `id` is 400; an unknown or already-deleted one is 404 `not_found`.

```bash
curl -s -X POST http://localhost:3000/api/shops/harts/blocks \
  -H "Authorization: Bearer $OWNER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"staffId":"dana","start":"2026-12-24T00:00:00-05:00","end":"2026-12-27T00:00:00-05:00","reason":"Holiday"}'

curl -s "http://localhost:3000/api/shops/harts/blocks?from=2026-12-01T00:00:00-05:00&to=2027-01-01T00:00:00-05:00" \
  -H "Authorization: Bearer $OWNER_API_TOKEN"

curl -s -X DELETE "http://localhost:3000/api/shops/harts/blocks?id=bf989345-1adc-49f8-96ba-cefb85fe32f5" \
  -H "Authorization: Bearer $OWNER_API_TOKEN"
```

```json
{ "block": { "id": "bf989345-1adc-49f8-96ba-cefb85fe32f5", "staffId": "dana", "start": "2026-12-24T00:00:00-05:00", "end": "2026-12-27T00:00:00-05:00", "reason": "Holiday" } }
```

### Services

`GET /api/shops/[shop]/services` stays public (above). Adding and changing services needs the token.

- `POST` (`CreateServiceRequest`, a whole `Service`) → **201** `ServiceResponse`. The service goes at the end of the list.
  - `id`: 1–40 lowercase letters, digits and hyphens, starting with a letter or digit, unique in the shop. A taken id is 400 (`details.field: "id"`).
  - `name`: 1–80 characters (trimmed).
  - `durationMin`: whole number, 5–480.
  - `priceCents`: whole number, 0–1,000,000.
  - `depositCents`: whole number, 0 up to `priceCents`.
- `PATCH /api/shops/[shop]/services/[id]` (`UpdateServiceRequest`) → `ServiceResponse`. Any of `name`, `durationMin`, `priceCents`, `depositCents`, at least one; the id can't change. `depositCents` ≤ `priceCents` is checked on the merged values, and again by the database on the row as it is when the change applies, so two `PATCH`es at the same moment (one raising the deposit, one lowering the price) can't combine into a deposit over the price: the second gets 400 (`details.field: "depositCents"`). An unknown id is 404 `not_found` with `details.valid_service_ids`. Existing bookings keep the deposit they were booked with (`Booking.depositCents`).

```bash
curl -s -X POST http://localhost:3000/api/shops/harts/services \
  -H "Authorization: Bearer $OWNER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"kids-cut","name":"Kids cut","durationMin":20,"priceCents":2000,"depositCents":0}'

curl -s -X PATCH http://localhost:3000/api/shops/harts/services/haircut \
  -H "Authorization: Bearer $OWNER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"priceCents":4000}'
```

```json
{ "service": { "id": "haircut", "name": "Haircut", "durationMin": 30, "priceCents": 4000, "depositCents": 1000 } }
```

### Booking actions

`POST /api/shops/[shop]/bookings/[id]/cancel`, `/complete` and `/no-show` apply the [transition table](#transitions) with actor `owner`. They take no body (one is ignored) and no idempotency key. They write one event each.

- Success: `OwnerBookingActionResponse`, i.e. `{ booking, depositEffect, depositCollected: false }`.
- The booking's status or time doesn't allow it → 400 `invalid_request` with `details.status`, `details.action` and `details.booking_id`. Repeating an action that succeeded lands here too, because the booking is now final.
- Unknown id, malformed id or another shop's booking → 404 `booking_not_found`.

```bash
curl -s -X POST http://localhost:3000/api/shops/harts/bookings/<booking id>/no-show \
  -H "Authorization: Bearer $OWNER_API_TOKEN"
```

```json
{
  "booking": {
    "id": "5e4cd04c-c8d2-4c5f-aa75-b58d2389e3cc",
    "shopSlug": "harts",
    "serviceId": "haircut",
    "serviceName": "Haircut",
    "staffId": "dana",
    "start": "2026-11-10T10:00:00-05:00",
    "end": "2026-11-10T10:30:00-05:00",
    "display": "Tue 10 Nov, 10:00 am EST",
    "status": "no_show",
    "customer": { "displayName": "Sam", "verified": false },
    "agent": { "name": "unknown agent" },
    "depositCents": 1000,
    "createdAt": "2026-11-10T10:00:00-05:00"
  },
  "depositEffect": "captured",
  "depositCollected": false
}
```

```json
{
  "error": {
    "code": "invalid_request",
    "message": "You can only mark a booking completed after its start time.",
    "next_action": "Try again once the appointment has started, or cancel the booking if it isn't going ahead.",
    "details": { "status": "confirmed", "action": "complete", "booking_id": "3f445383-9d10-4aa9-9ee5-34b39a122259" }
  }
}
```

### `GET /api/shops/[shop]/bookings/[id]` → `BookingDetailResponse`

The booking and its [events](#events), oldest first. Unknown id → 404 `booking_not_found`.

```bash
curl -s http://localhost:3000/api/shops/harts/bookings/<booking id> -H "Authorization: Bearer $OWNER_API_TOKEN"
```

```json
{
  "booking": {
    "id": "5e4cd04c-c8d2-4c5f-aa75-b58d2389e3cc",
    "shopSlug": "harts",
    "serviceId": "haircut",
    "serviceName": "Haircut",
    "staffId": "dana",
    "start": "2026-11-10T10:00:00-05:00",
    "end": "2026-11-10T10:30:00-05:00",
    "display": "Tue 10 Nov, 10:00 am EST",
    "status": "no_show",
    "customer": { "displayName": "Sam", "verified": false },
    "agent": { "name": "unknown agent" },
    "depositCents": 1000,
    "createdAt": "2026-11-10T10:00:00-05:00"
  },
  "events": [
    {
      "id": "7",
      "bookingId": "5e4cd04c-c8d2-4c5f-aa75-b58d2389e3cc",
      "at": "2026-11-10T10:00:00-05:00",
      "actor": "agent",
      "type": "booked",
      "data": { "status": "confirmed", "agentName": "unknown agent" }
    },
    {
      "id": "8",
      "bookingId": "5e4cd04c-c8d2-4c5f-aa75-b58d2389e3cc",
      "at": "2026-11-10T10:00:00-05:00",
      "actor": "owner",
      "type": "no_show",
      "data": { "from": "confirmed", "to": "no_show", "depositEffect": "captured", "depositCollected": false }
    }
  ]
}
```

## Try the full loop

Start the app. With `DATABASE_URL` set (see [database.md](database.md)), bookings go to Postgres. Without it, they go to an in-memory store that resets when the server restarts. Put an owner token in `.env.local` (git-ignored) so the owner routes work:

```bash
echo "OWNER_API_TOKEN=$(openssl rand -hex 32)" >> .env.local
FRONTDESK_NOW=2026-11-10T10:00:00-05:00 pnpm dev
```

The frozen clock makes the examples valid. It's Tuesday 10 Nov, 10:00 am, a day Hart's is open (it's closed Sunday and Monday). Saturday 14 Nov is 4 days ahead: inside the 6-day deposit horizon a haircut has, and more than 24 hours ahead, so cancelling releases the deposit.

Then, in another terminal, with MCP Inspector's CLI and curl:

```bash
export OWNER_API_TOKEN=<the value in .env.local>
I="npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp --transport http"
O=http://localhost:3000/api/shops/harts
AUTH="Authorization: Bearer $OWNER_API_TOKEN"

# 1. What does the shop sell, and what are its rules?
$I --method tools/call --tool-name list_services
$I --method tools/call --tool-name get_policies

# 2. Today: nothing before 12:00 (2-hour lead time) and nothing at 12:00 (lunch), so the first start is 12:30
$I --method tools/call --tool-name get_availability \
  --tool-arg service_id=haircut --tool-arg from=2026-11-10T00:00:00-05:00 --tool-arg to=2026-11-11T00:00:00-05:00

# 3. When is a haircut free on Saturday?
$I --method tools/call --tool-name get_availability \
  --tool-arg service_id=haircut --tool-arg from=2026-11-14T00:00:00-05:00 --tool-arg to=2026-11-15T00:00:00-05:00

# 4. Book one of the returned starts, with a fresh idempotency key
K=$(uuidgen)
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Maya --tool-arg idempotency_key=$K
B=<the booking id from the text>

# 5. Retry with the same key → the same booking, marked "(replayed: …)"; nothing new is booked
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Maya --tool-arg idempotency_key=$K

# 6. Same slot, new key → slot_taken, with details.alternatives (1:45, 2:00 and 3:00 pm)
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Jo --tool-arg idempotency_key=$(uuidgen)

# 7. A haircut a week ahead → too_far (details.latest is 2026-11-16T10:00:00-05:00)
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-17T10:00:00-05:00 --tool-arg customer_name=Jo --tool-arg idempotency_key=$(uuidgen)

# 8. The UI's view: the booking is there
curl -s $O/bookings

# 9. Cancel it, 4 days ahead → cancelled, depositEffect "released", depositCollected false
$I --method tools/call --tool-name get_booking --tool-arg booking_id=$B
$I --method tools/call --tool-name cancel --tool-arg booking_id=$B --tool-arg idempotency_key=$(uuidgen)

# 10. The owner's view: a booked event, then a cancelled event
curl -s $O/bookings/$B -H "$AUTH"

# 11. The owner pauses bookings → get_availability returns nothing and book returns paused
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"paused": true}'
$I --method tools/call --tool-name get_availability \
  --tool-arg service_id=haircut --tool-arg from=2026-11-14T00:00:00-05:00 --tool-arg to=2026-11-15T00:00:00-05:00
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Maya --tool-arg idempotency_key=$(uuidgen)
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"paused": false}'

# 12. A no-show needs a booking whose start has passed. With the clock frozen, set the lead time to 0
#     and book the frozen "now" itself (Tue 10 Nov, 10:00 am): it starts now, so it has started.
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"leadTimeMin": 0}'
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-10T10:00:00-05:00 --tool-arg customer_name=Sam --tool-arg idempotency_key=$(uuidgen)
P=<the booking id from the text>
curl -s -X POST $O/bookings/$P/no-show -H "$AUTH"      # → no_show, depositEffect "captured"
curl -s $O/bookings/$P -H "$AUTH"                      # → booked, then no_show by the owner
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"leadTimeMin": 120}'
```

After step 4, `get_availability` no longer offers 2:15, 2:30 or 2:45 pm. After step 9 it offers them again. With Postgres, the owner's changes persist, so step 11 and 12 put them back. Run the loop on a fresh database (or the in-memory store) to get the same results.

## Demo data

The seed ([`supabase/seed.sql`](../supabase/seed.sql)) has one shop, and the in-memory store has the same data:
- Hart's Barbers has one staff member, Dana (`dana`), who works Tue–Sat 9:00–12:00 and 12:30–17:00. The gap is lunch. It's closed Sunday and Monday.
- It has three services. Haircut and Haircut + beard trim take a $10 deposit; Beard trim doesn't.
- Its policies: book at least 2 hours ahead; up to 30 days ahead, or 6 days for a service with a deposit; cancel at least 24 hours ahead for the deposit to be released. Phone `+1 212-555-0142`. Not paused. The three plain-language rules are in the `get_policies` example above.
- A Postgres database starts with no bookings and no blocked times, and so does the in-memory store.

### Freezing time: `FRONTDESK_NOW`

Set `FRONTDESK_NOW` to an RFC 3339 instant to freeze Front Desk's clock. Demos are then reproducible, because everything that depends on "now" is computed from that instant: the lead time, the horizons, which starts are past, the cancellation window, and whether an appointment has started.

```bash
FRONTDESK_NOW=2026-11-10T10:00:00-05:00 pnpm dev
```

What it doesn't freeze depends on the store:
- **Postgres:** `createdAt`, event times (`at`), the lifecycle timestamps and the age of idempotency keys are the database's real time (`now()`). Keys still expire 24 real hours after they were first used.
- **In-memory store:** those use the frozen clock too, so `createdAt` and event times show the frozen instant, and idempotency keys never expire while the clock is frozen.

On Vercel, set it as an environment variable. Leave it unset to use real time. An invalid value makes every call that reads the clock fail with `internal`, and the server log explains why.

## Connecting

### MCP Inspector

```bash
pnpm dev
npx @modelcontextprotocol/inspector
```

In the Inspector UI:
1. Choose transport **Streamable HTTP**.
2. Enter `http://localhost:3000/api/mcp` (or a preview URL plus `/api/mcp`) and click **Connect**.
3. Open **Tools**, then **List Tools**. You should see six tools: `list_services`, `get_policies`, `get_availability`, `book`, `get_booking` and `cancel`.

`book` and `cancel` need an `idempotency_key`: paste a fresh UUID (e.g. from `uuidgen`). To see a replay, call again with the same one.

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

Then ask, for example: *"What haircut times does Hart's Barbers have this Saturday?"*, then *"Book the 2:30 for Maya."*, then *"Actually, cancel it."*

Vercel Deployment Protection on preview URLs blocks outside clients like Claude. To test a preview from Claude, use a protection-bypass link, or test on production after merge.

## Not built yet

These are marked `TODO(ring-N)` in the code:

| Ring | Item | Where |
|---|---|---|
| ring-1b | Verified customer identity, consent and mandate (`customer.verified` is always `false`) | `lib/server/frontdesk/service.ts` (`book`) |
| ring-1b | Anyone holding a booking id can read or cancel it, until customer consent ships | `lib/server/frontdesk/service.ts` (`getBooking`, `cancelBooking`), `app/api/mcp/route.ts` |
| ring-1c | Collect deposits and move money (`depositEffect` is the policy's decision; `depositCollected` is always `false`) | `lib/server/frontdesk/service.ts` (`book`, `transitionBooking`), `lib/server/engine/lifecycle.ts` |
| ring-1c | `awaiting_deposit` and `expired` (book creates `confirmed` bookings until deposits come with Stripe) | `lib/server/frontdesk/service.ts` (`book`) |
| ring-1c | Owner alerts on a real channel (Photon) instead of a log line, including when an agent cancels | `lib/server/notify/log-notifier.ts`, `lib/server/frontdesk/service.ts` (`cancelBooking`) |
| ring-2 | Let agents pick the shop (by slug or URL) instead of hard-coding Hart's | `lib/server/frontdesk/mcp.ts` (`DEFAULT_SHOP_SLUG`) |
| ring-2 | Owner sign-in replaces `OWNER_API_TOKEN`, and protects the public bookings route | `lib/server/frontdesk/owner-auth.ts`, `lib/server/frontdesk/http.ts`, the owner route files, `lib/server/frontdesk/service.ts` (`listShopBookings`) |
| ring-2 | MCP sign-in: authenticate callers (`book` and `cancel` are open to anyone) | `app/api/mcp/route.ts` |
| ring-2 | Verified agent identity instead of the self-reported client name | `lib/server/frontdesk/mcp.ts` (`agentNameFrom`) |
| ring-2 | A job that deletes idempotency keys older than 24 hours | `lib/server/frontdesk/booking-store.ts` (`IDEMPOTENCY_TTL_MS`), `supabase/migrations/0002_rules.sql` |

A UI for any of this is v0's lane.
