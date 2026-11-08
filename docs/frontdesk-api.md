# Front Desk agent API (MCP)

Front Desk lets AI agents (Claude, ChatGPT, personal agents) ask a small business what it offers, what its rules are and when it's free, then book or cancel an appointment. Agents connect over the [Model Context Protocol](https://modelcontextprotocol.io). The UI reads the same data over plain JSON routes, and the owner's console changes it over owner routes.

**No booking is final until a real person approves it.** `book` holds the slot for 10 minutes and returns an approval link; the person opens it and approves or declines. Opening the link and tapping Approve is the consent. This works with any MCP client, with no OAuth. See [Consent flow](#consent-flow).

| | |
|---|---|
| Endpoint | `<origin>/api/mcp`, e.g. `http://localhost:3000/api/mcp` or `https://<preview>.vercel.app/api/mcp` |
| Transport | Streamable HTTP, stateless (`POST` only; `GET` answers 405) |
| Auth | MCP: optional OAuth sign-in for the person ([connector-signin.md](connector-signin.md)); anonymous calls work as before. Approval routes: the token in the link. Owner routes: `Authorization: Bearer <OWNER_API_TOKEN>` or the `fd_owner` cookie (see [Owner routes](#owner-routes)). |
| Shop | One shop for now: Hart's Barbers (`harts`), `America/New_York` |
| Tools | `list_services`, `get_policies`, `get_availability`, `get_booking`, `list_my_bookings` (read-only; the last needs sign-in), `book` and `cancel` |
| Public routes | `GET /api/shops/[shop]/services` |
| Approval routes | `GET /api/approvals/[token]`, `POST /api/approvals/[token]/approve`, `/decline` (the approval page at `/approve/[token]` uses them) |
| Owner routes | the bookings list, policies, hours, blocked time, services, booking actions, booking history and owner alerts under `/api/shops/[shop]/`; the owner session at `/api/owner/session` |
| Pages | `/approve/[token]` (the link the person opens), `/console` and `/console/unlock` (the owner's bookings) |
| Data | Postgres (Supabase). See [database.md](database.md). |

Request and response shapes are exported from [`lib/types/frontdesk.ts`](../lib/types/frontdesk.ts):
- Shared: `Shop`, `Service`, `Slot`, `Policies`, `AgentPolicies`, `Booking`, `BookingStatus`, `DepositEffect`, `BookingEvent`, `BookingActor`, `BookingEventType`, `Mandate`, `ApiError`, `ApiErrorCode`.
- Connector sign-in ([`lib/types/oauth.ts`](../lib/types/oauth.ts), [connector-signin.md](connector-signin.md)): `ListMyBookingsInput`, `ListMyBookingsResult`, `CustomerProfile`, and the OAuth shapes.
- Tools: `ListServicesResult`, `GetPoliciesResult`, `GetAvailabilityInput`, `GetAvailabilityResult`, `BookInput`, `BookResult`, `GetBookingInput`, `GetBookingResult`, `CancelInput`, `CancelResult` (= `BookingTransitionResult`).
- Public routes: `ServicesResponse`.
- Approval routes: `ApprovalView`, `ApproveRequest`, `ApproveResponse`, `DeclineResponse`.
- Owner routes: `BookingsResponse`, `OwnerSessionRequest`, `OwnerSessionResponse`, `PoliciesResponse`, `UpdatePoliciesRequest`, `HoursResponse`, `UpdateHoursRequest`, `WeeklyHours`, `StaffWeeklyHours`, `BlocksResponse`, `CreateBlockRequest`, `BlockResponse`, `BlockedTime`, `CreateServiceRequest`, `UpdateServiceRequest`, `ServiceResponse`, `OwnerBookingActionResponse`, `BookingDetailResponse`, `Alert`, `AlertKind`, `AlertChannel`, `AlertStatus`, `AlertsResponse`.
- Environment: `StatusResponse`.

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

The HTTP status applies to the `/api/shops/*` and `/api/approvals/*` routes. Tools always answer a normal MCP result with `isError: true`.

| `code` | HTTP | When | `details` | `next_action` |
|---|---|---|---|---|
| `invalid_request` | 400 | Bad arguments or body. `book` with an unknown `service_id` or a malformed `mandate`. An owner action the booking's status or time doesn't allow. `approve` with a phone number that isn't E.164. | Tools: `field`, `value`. Owner bodies: `field`, `issues`. Owner actions: `status`, `action`, `booking_id`. Approval routes: `field` (`phone` or `body`), never the value. | Says what to send instead. |
| `not_found` | 404 | No such shop, service (`get_availability`, `PATCH` service), staff member or blocked time. | What was asked for, plus the valid ids where useful (`valid_service_ids`, `valid_staff_ids`). | Check the slug or id; use one of the valid ids. |
| `slot_taken` | 409 | `book`: a booking is in the way, or another agent won the race for that time and no other staff member is free then. | `start`, `service_id`, `alternatives` (up to 3 nearby `Slot`s, possibly empty) | "Someone just took that time. Call get_availability again and choose another start." When there are alternatives it adds "Nearby open starts you can offer instead are in details.alternatives." |
| `outside_hours` | 422 | `book`: not a bookable start for that service: closed, lunch, blocked time, off the 15-minute grid, or the service would run past closing. | `field: "start"`, `value`, `service_id` | "Call get_availability and choose one of the returned starts." |
| `too_soon` | 422 | `book`: before now + the lead time (rounded up to the grid). This includes the past. | `earliest`, `lead_time_min`, `start` | "Pick a later time: call get_availability from details.earliest." |
| `too_far` | 422 | `book`: at or after the booking horizon for that service. | `latest` (starts must be before it), `horizon_days`, `start` | "Pick an earlier time, before details.latest." |
| `paused` | 409 | `book`: the owner paused bookings. | `phone` (or `null`) | "Tell the person to call the shop at +1 212-555-0142." (without the number if there's none) |
| `booking_not_found` | 404 | `get_booking`, `cancel`, owner booking routes: no booking with that id at this shop. A malformed id or another shop's booking is also not found. Approval routes: an unknown or malformed token. | `booking_id` (none for a token) | "Check the booking id. It is the booking.id (a UUID) that book returned." (token: "Check that the whole link was copied. …") |
| `not_cancellable` | 409 | `cancel`: the booking is already final (cancelled, expired, completed, no-show; a hold whose time ran out has expired), or its start has passed. | `status`, `booking_id`, and `start` when it has started | "Don't retry. If the person still needs to change it, tell them to call the shop at +1 212-555-0142." |
| `unauthorized` | 401 | An owner route without the right bearer token or `fd_owner` cookie, or the deployment has no `OWNER_API_TOKEN`. | none | "Send the header Authorization: Bearer <OWNER_API_TOKEN>." The bookings list says "Open /console/unlock and enter the shop's access code." With no token set: "Owner access isn't set up: set OWNER_API_TOKEN in Vercel and redeploy." |
| `outside_mandate` | 422 | `book`: the service or time breaks the person's [mandate](#mandate). | `field`: `price_cap` (+ `priceCents`, `priceCapCents`), `deposit_cap` (+ `depositCents`, `depositCapCents`) or `window` (+ `window`, `start`, `end`) | "Ask the person to widen their limit, or choose a different service or time." |
| `approval_expired` | 410 | Approval routes: the 10-minute hold ran out before the person approved (the booking is `expired`). | `status`, `booking_id` | "Ask your agent to book again." |
| `approval_closed` | 409 | Approval routes: the request was already approved or declined, or the agent or shop cancelled the booking. | `status`, plus `decision` when it was answered | "Nothing more to do with this link. Ask your agent if you need a new booking." |
| `internal` | 500 | Our fault: the database is unreachable, `DATABASE_URL` is missing on Vercel, or `FRONTDESK_NOW` is invalid. | none | "Retry the same call once. If it fails again, tell the user Front Desk is unavailable right now." |

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

`policies` is `AgentPolicies`: every `Policies` field except `ownerEmail` and `ownerMobile`, which only the owner routes show. They aren't rules an agent needs, and the owner's address and number aren't for every agent that connects.

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

**Holds** an appointment for 10 minutes until the person approves it, and returns an approval link. Nothing is final until they do: see [Consent flow](#consent-flow). Call it only once the person has picked a time and heard the shop's rules (`get_policies`).

- The result's booking has `status: "awaiting_approval"` and `approval: { url, expiresAt }`. **Send the person `approval.url` right away**, then call `get_booking` to see what they did. While the hold is on, `get_booking`, the owner's bookings list and booking detail return the same link, so an agent that lost it can fetch it again and the owner can copy it.
- The held slot is busy: `get_availability` stops offering it and another `book` for it gets `slot_taken`. If the person declines, or the hold runs out (`approval.expiresAt`), the slot is free again.
- `start` must be one of the starts `get_availability` just returned for the same service. Any other time is refused with the most specific code (see Errors).
- **Call it once per booking.** Calling it again for the same time gets `slot_taken` while the first hold is on (the database's `no_overlap` constraint), so a retry can't double-book. If a call timed out, an agent that has the booking id calls `get_booking`; otherwise it checks `get_availability` or with the person before booking again.
- **`mandate` is optional:** the person's limits. The server refuses a booking outside them (`outside_mandate`) and shows them on the approval page. See [Mandate](#mandate). `TODO(ring-2)`: required once agents sign in.
- **`customer_phone` is optional:** the person's mobile number, E.164. It's stored on the booking (`customer.phone`). Where texting is on, Front Desk texts the approval link to it and the result has `texted: true`; the agent then doesn't send the link again. `texted: false` means the agent sends it as usual. See [texting.md](texting.md#1-the-approval-link-by-text).
- **No deposit is collected yet.** `depositCents` is the deposit the service required when it was booked; it will be collected once deposits are enabled.
- **The owner isn't told about a hold**, only about a booking the person approved.
- `agent.name` is a best-effort label: the MCP client's self-reported name, with control characters removed and cut to 80 characters. Clients on the 2026-07-28 protocol send it with every request. Stateless 2025-era requests don't, so those bookings show `"unknown agent"`. MCP Inspector is one of these.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` (each call places a new hold or is refused), `openWorldHint: false`.

| Field | Type | Notes |
|---|---|---|
| `service_id` | string | Required. An `id` from `list_services`. |
| `start` | string | Required. A slot `start` from `get_availability`, RFC 3339 with offset. Any offset is accepted if it's the same instant. |
| `customer_name` | string | 1–80 characters after trimming, without the NUL character (U+0000). The name the booking is under. Required unless the agent is signed in as the person, when it defaults to the name they signed in with; leaving it out without sign-in asks them to sign in (HTTP 401, see [connector-signin.md](connector-signin.md#the-gate)). |
| `mandate` | object | Optional. `{ priceCapCents?, depositCapCents?, window?: { from, to } }`. See [Mandate](#mandate). |
| `customer_phone` | string | Optional; defaults to the signed-in person's number ([connector-signin.md](connector-signin.md#the-gate)). The person's mobile, E.164 (spaces, dashes, dots and parentheses are ignored); anything else is `invalid_request`, `details.field: "customer_phone"`. Stored as `customer.phone`, and texted the approval link where texting is on. |

**Input**

```json
{
  "service_id": "haircut",
  "start": "2026-11-14T14:30:00-05:00",
  "customer_name": "Maya",
  "mandate": { "priceCapCents": 5000, "window": { "from": "2026-11-14T12:00:00-05:00", "to": "2026-11-14T18:00:00-05:00" } }
}
```

**Text content**

```
Held Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. It is not confirmed yet.
Hold placed until Tue 10 Nov, 11:10 am EST. Send Maya this link to approve: http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM. Then call get_booking to check the status.
A $10 deposit will be required once deposits are enabled; nothing was charged.
Booking id: bd3db26a-83b1-403c-b923-357982915d3c. Don't book this time again while the hold is on. If Maya declines or the hold runs out, the time is freed.
```

**`structuredContent`** (`BookResult`)

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
    "customer": { "displayName": "Maya", "approved": false },
    "agent": { "name": "unknown agent" },
    "depositCents": 1000,
    "createdAt": "2026-11-10T11:00:00-05:00",
    "approval": {
      "url": "http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM",
      "expiresAt": "2026-11-10T11:10:00-05:00"
    }
  }
}
```

This example ran with the clock frozen at Tue 10 Nov, 11:00 am. With Postgres, `createdAt` is the database's real time; `approval.expiresAt` always follows Front Desk's clock. The link's origin is the origin of the request the agent made to `/api/mcp`, so it works on previews and in production with no setting.

**How it decides:**
1. It checks the arguments, the mandate included (`invalid_request`).
2. It checks `start` against the shop's rules, using the current clock, in this order: `paused`, then `too_soon` (lead time), then `too_far` (horizon). These don't read any bookings, so a start in year 1 or year 9999 is simply `too_soon` or `too_far`.
3. `decide()` checks the [mandate](#mandate) (`outside_mandate`: price, then deposit, then window) and sets the hold's deadline, now + 10 minutes.
4. It expires lapsed holds around that time, just before inserting (lazy expiry), so a hold nobody answered never blocks the booking. Then it checks hours and busy time: if a booking or a live hold is in the way it's `slot_taken`, otherwise `outside_hours` (closed, lunch, blocked time, off the grid, or running past closing). The staff member comes from the free slot.
5. It stores the hold, its approval request (a new 32-byte random token, stored as it is) and its `booked` event in one statement. The database's `no_overlap` constraint, which covers holds, has the final word, so two agents racing for the same staff member and time can't both win. The loser reads busy time again: if another staff member is free at exactly that start, it books them instead (once). Otherwise, or if that insert loses too, it gets `slot_taken` with alternatives.

**Errors**

| `code` | When | `details` | `next_action` |
|---|---|---|---|
| `slot_taken` | A booking is already there. This covers booking the same slot twice, an overlapping service (e.g. a 45-min haircut-beard at 9:45 when 10:00 is booked), and losing a race to another agent when no other staff member is free at that start (or the one retry with them loses too). | `start`, `service_id`, `alternatives`: up to 3 free starts within 24 hours either side, closest first (listed earliest first), under the same rules. They include `start` itself if some staff member is still free then. | "Someone just took that time. Call get_availability again and choose another start." plus, when there are alternatives, "Nearby open starts you can offer instead are in details.alternatives." |
| `too_soon` | `start` is before now + the lead time, rounded up to the grid (or in the past). | `earliest`, `lead_time_min`, `start` | "Pick a later time: call get_availability from details.earliest." |
| `too_far` | `start` is at or after the horizon: 6 days ahead for a service with a deposit, 30 days otherwise. | `latest`, `horizon_days`, `start` | "Pick an earlier time, before details.latest." |
| `outside_hours` | `start` isn't a bookable time for that service: off the 15-minute grid, outside opening hours (including lunch, 12:00–12:30), on a closed day, on blocked time, or the service would run past closing. | `field: "start"`, `value`, `service_id` | "Call get_availability and choose one of the returned starts." |
| `paused` | The owner paused bookings. | `phone` | "Tell the person to call the shop at +1 212-555-0142." |
| `outside_mandate` | The service's price or deposit is over the person's cap, or the appointment isn't inside their window. | `field` (`price_cap`, `deposit_cap` or `window`) and the numbers or times compared | "Ask the person to widen their limit, or choose a different service or time." |
| `invalid_request` | Unknown `service_id`. | `field`, `value`, `valid_service_ids` | Call `list_services`, then `get_availability`. |
| `invalid_request` | `start` isn't RFC 3339 with an offset; `customer_name` is missing, blank, over 80 characters or contains the NUL character (U+0000); `mandate` isn't an object, has an unknown field, a cap that isn't a whole number of cents from 0 to 100,000,000, or a window that isn't `{ from, to }` RFC 3339 with `from` before `to`; a field is missing or the wrong JSON type. | `field` (e.g. `mandate.window.to`), `value` | Says what to send instead. |

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

```json
{
  "error": {
    "code": "outside_mandate",
    "message": "This service costs $35.00, more than the person's limit of $30.00.",
    "next_action": "Ask the person to widen their limit, or choose a different service or time.",
    "details": { "field": "price_cap", "priceCents": 3500, "priceCapCents": 3000 }
  }
}
```

## `get_booking`

Reads one booking by its id. Call it after sending the approval link to see what the person did: `awaiting_approval` (not answered yet), `confirmed` (approved: `customer.approved` is `true`, and `customer.phone` is set if they gave a phone number), `cancelled` (declined, or cancelled by the agent or the shop) or `expired` (the hold ran out). Read-only, except that reading a hold whose time ran out records that it expired ([lazy expiry](#lazy-expiry)).

- While the booking is `awaiting_approval` it includes `approval: { url, expiresAt }`, the same link `book` returned. An agent that lost the link gets it here.
- **Anyone holding a booking id can read it** (`TODO(ring-2)`: agent identity fixes this).

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
Maya approved it. It is confirmed.
Deposit: $10 (not collected yet). Booking id: bd3db26a-83b1-403c-b923-357982915d3c.
```

The middle line depends on the status:
- `awaiting_approval`: `Waiting for Maya to approve with this link: http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM (the hold lapses at Tue 10 Nov, 11:10 am EST). Remind them if needed, then call get_booking again.`
- `expired`: `The hold ran out before Maya approved, so the time is free again. Book again if they still want it.`
- `cancelled` after the person declined: `Maya declined it, so the time is free again.` (no line for other cancellations)

A service without a deposit says `No deposit.` instead of the deposit.

**`structuredContent`** (`GetBookingResult`): `{ "booking": Booking }`, the same `Booking` shape `book` returns, with its current `status` (and `approval` only while it's `awaiting_approval`). After approval:

```json
{
  "booking": {
    "id": "bd3db26a-83b1-403c-b923-357982915d3c",
    "status": "confirmed",
    "customer": { "displayName": "Maya", "approved": true, "phone": "+14015550123" },
    "…": "the other Booking fields"
  }
}
```

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
- a hold still awaiting approval → `cancelled` any time, deposit `released` (nothing was ever held); the approval link then shows `expired`;
- a confirmed booking at least `cancelWindowHours` (24 for Hart's) before the start → `cancelled`, deposit `released`;
- later, but before the start → `cancelled`, deposit `captured` (the shop keeps it as a late fee);
- at or after the start, or from a final status (a hold whose time ran out has expired) → `not_cancellable`.

The agent should tell the person the consequence and get their go-ahead first.

- **Nothing is collected yet.** `depositEffect` is what the policy decides; `depositCollected` is always `false` until Ring 1c.
- **Retrying is harmless.** Cancelling an already-cancelled booking is `not_cancellable`, so a retry never cancels twice or writes a second event.
- **Anyone holding a booking id can cancel it** (`TODO(ring-2)`: agent identity fixes this).
- Once it's cancelled, the owner is alerted (`booking_cancelled`; see [Owner alerts](#owner-alerts)). A failed alert never undoes the cancel.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`.

| Field | Type | Notes |
|---|---|---|
| `booking_id` | string | Required. The `booking.id` (a UUID) that `book` returned. |

**Input**

```json
{ "booking_id": "632aa35c-4e9e-4a08-8880-b5b1165939e2" }
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
    "customer": { "displayName": "Maya", "approved": false },
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
| `invalid_request` | `booking_id` is missing or malformed. | `field`, `value` | Says what to send instead. |

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

## `list_my_bookings`

The signed-in person's bookings at the shop, for "What appointments do I have?". **Needs sign-in:** called without a token, `/api/mcp` answers HTTP 401 with `WWW-Authenticate` so the client signs the person in and retries (see [connector-signin.md](connector-signin.md#the-gate)).

- Takes no arguments.
- Returns `{ customer: { name, phone }, bookings: Booking[], truncated }` (`ListMyBookingsResult` in [`lib/types/oauth.ts`](../lib/types/oauth.ts)): every status, bookings that end within the last 7 days or later, sorted by start, at most 50. Lapsed holds read as `expired`; a booking awaiting approval or its deposit carries `approval.url`.
- The text names who is signed in and lists each booking with its id, for `get_booking` and `cancel`.
- Annotations: read-only (it records holds that ran out, like `get_booking`).

**Text content**

```
Maya Lopez (+14015550123) is signed in. Their bookings at Hart's Barbers (from the last 7 days on):
- Haircut, Wed 11 Nov, 9:00 am EST: confirmed. Booking id: 0f0c…
- Beard trim, Sat 7 Nov, 2:30 pm EST (past): completed. Booking id: 7a1e…
Pass a booking id to get_booking for details or to cancel (tell the person the deposit consequence first).
```

## Consent flow

A booking only becomes final when the person it's for approves it themselves, through a link only they receive. Nothing depends on the MCP client: any client that can show a link works, with no OAuth.

```
agent                         Front Desk                         person
  │  book(service, start, name,    │                                  │
  │       mandate?)                │                                  │
  │ ─────────────────────────────► │ hold the slot 10 min             │
  │ ◄───────────────────────────── │ awaiting_approval + approval.url │
  │  send the link ──────────────────────────────────────────────────►│
  │                                │ ◄── GET  /approve/[token]        │ the page shows the booking,
  │                                │                                  │ the rules and the mandate
  │                                │ ◄── POST …/approve (phone?)      │ or POST …/decline
  │                                │ confirmed (or cancelled),        │
  │                                │ owner alerted                    │
  │  get_booking(id) ────────────► │                                  │
  │ ◄───────────────────────────── │ confirmed / cancelled / expired  │
```

1. `book` returns the booking in `awaiting_approval` with `approval.url` = `<origin>/approve/<token>` and `approval.expiresAt` (now + 10 minutes). The origin is the origin of the request the agent made to `/api/mcp`, so links work on previews and in production with no setting. The token is 32 random bytes, base64url, stored as it is (`approvals.token`), so every booking response carries the link while the hold is on: `get_booking`, the owner's bookings list and booking detail.
2. The agent sends the person the link. The page at `/approve/[token]` shows the shop, service, time, price, deposit ("not charged yet"), the cancellation rules, the agent's name, the name booked under and the mandate, plus an optional phone field, **Approve** and **Decline**, and when the hold expires. It's a plain server-rendered page with HTML forms (no client JS), a stand-in until v0 restyles it. Other clients can use [the approval API](#approval-api).
3. **Approve** (`POST …/approve`): opening the link and tapping Approve is the consent. The booking becomes `confirmed`, `customer.approved` becomes `true`, and the owner is alerted (`booking_confirmed`; see [Owner alerts](#owner-alerts)). A hold alone never alerts anyone. The person may give a phone number; it's stored with the booking as plain E.164 and shown as `customer.phone`. Nothing checks that it's theirs. `TODO(ring-1c)`: a code texted to that number comes back once real texting ships, and a service with a deposit will go to `awaiting_deposit` instead of `confirmed`.
   **Decline** (`POST …/decline`): the booking becomes `cancelled` (`cancelled_by` `customer`), the slot is free, and the owner is alerted (`booking_cancelled`).
   **No answer:** after 10 minutes the hold expires (`expired`) and the slot is free.
4. The agent calls `get_booking` to see which happened, and tells the person.

The agent (`cancel`) or the owner can drop a hold at any time; the link then shows `expired` and refuses further answers (`approval_closed`).

### Lazy expiry

Once a day the [nightly tidy-up](nightly.md) expires every hold past its deadline, even one nobody reads. In between, a hold past its deadline expires the next time something touches it, in the same transaction as that read or write, with one `expired` event (actor `system`):
- `book` expires lapsed holds around its start before inserting, so **a stale hold never blocks a new booking**;
- `get_booking`, `cancel`, the owner's booking routes and the approval routes expire the booking they read;
- the owner's `GET /api/shops/[shop]/bookings` expires lapsed holds in its range before listing;
- `get_availability` only reads: it skips lapsed holds without writing.

### Approval API

Public routes behind the approval page. **The token in the path is the credential**: no sign-in. Request-time only, `Cache-Control: no-store`, errors in the `ApiError` envelope.

- An unknown or malformed token is **404** `booking_not_found` (a malformed one isn't even looked up).
- The token is stored as it is and never logged or echoed in an error. The hosting platform's request log records request paths, so it appears there.
- Anyone holding the link can approve or decline, from anywhere.

| Method and path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/approvals/[token]` | | `ApprovalView` | 404 |
| `POST /api/approvals/[token]/approve` | `ApproveRequest` (optional), as JSON or a form post | `ApproveResponse`; a form post gets **303** → `/approve/<token>` | 400, 404, 409 `approval_closed`, 410 `approval_expired` |
| `POST /api/approvals/[token]/decline` | none (JSON or a form post) | `DeclineResponse`; a form post gets **303** → `/approve/<token>` | 404, 409 `approval_closed`, 410 `approval_expired` |

**Form posts.** A plain HTML form post (`application/x-www-form-urlencoded`, or `multipart/form-data`) to `…/approve` (optional `phone` field) or `…/decline` answers **303** with `Location: <origin>/approve/<token>`, so the page reloads and shows the new status. If the answer is refused, the redirect adds `?error=<code>` (e.g. `?error=invalid_request` for a phone number that isn't E.164); the page explains the ones the person can fix. JSON posts answer JSON as below.

#### `GET /api/approvals/[token]` → `ApprovalView`

Expires the hold first if it lapsed. `status` is `pending` (the person can answer), `approved`, `declined`, or `expired` (the hold ran out, or the agent or shop cancelled before the person answered). `mandate` is there only when the agent sent one.

```json
{
  "status": "pending",
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "serviceName": "Haircut",
  "display": "Sat 14 Nov, 2:30 pm EST",
  "start": "2026-11-14T14:30:00-05:00",
  "end": "2026-11-14T15:00:00-05:00",
  "priceCents": 3500,
  "depositCents": 1000,
  "policies": {
    "cancelWindowHours": 24,
    "depositRule": "Services with a deposit need it when you book. We hold the deposit on your card at booking; it is only charged if you miss the appointment or cancel late.",
    "lateCancelRule": "Cancel at least 24 hours before your appointment and the deposit is released. Cancel within 24 hours and we keep the deposit as a late-cancellation fee.",
    "noShowRule": "If you don't show up, we keep the deposit. Otherwise it is released after your appointment."
  },
  "agentName": "unknown agent",
  "customerName": "Maya",
  "mandate": { "priceCapCents": 5000, "window": { "from": "2026-11-14T12:00:00-05:00", "to": "2026-11-14T18:00:00-05:00" } },
  "expiresAt": "2026-11-10T11:10:00-05:00"
}
```

#### `POST /api/approvals/[token]/approve` → `ApproveResponse`

Body (optional): no body, `{}`, or `{ "phone": "+14015550123" }`. The phone is E.164; spaces, dashes, dots and parentheses are ignored, and anything else is `invalid_request` (`details.field: "phone"`, the number isn't echoed). Checks, in order:
1. The approval is pending: already answered or cancelled → `approval_closed`; the hold ran out → `approval_expired` ("Ask your agent to book again.").
2. In one transaction, only if the hold is still on: the booking becomes `confirmed` with an `approved` event (actor `customer`), the phone is stored on the booking, and the approval is marked decided. After that commits, the owner is alerted once (`booking_confirmed`). A failed alert is recorded as `failed` and the answer is still 200 with the confirmed booking.

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
    "status": "confirmed",
    "customer": { "displayName": "Maya", "approved": true, "phone": "+14015550123" },
    "agent": { "name": "unknown agent" },
    "depositCents": 1000,
    "createdAt": "2026-11-10T11:00:00-05:00"
  }
}
```

```json
{
  "error": {
    "code": "approval_expired",
    "message": "The hold on this time ran out before it was approved, so the time is free again.",
    "next_action": "Ask your agent to book again.",
    "details": { "status": "expired", "booking_id": "e4a204ac-6513-416a-881f-f37465b301b6" }
  }
}
```

#### `POST /api/approvals/[token]/decline` → `DeclineResponse`

No body. The booking becomes `cancelled` (a `declined` event, actor `customer`) and the slot is free; then the owner is alerted (`booking_cancelled`). Only while pending.

#### Try it with curl

```bash
T=<the token at the end of approval.url>
A=http://localhost:3000/api/approvals/$T
curl -s $A
curl -s -X POST $A/approve -H "Content-Type: application/json" -d '{"phone":"+14015550123"}'
# or as the page's form does (303 → /approve/$T):
curl -s -i -X POST $A/approve -d 'phone=+1 401 555 0123'
```

### Mandate

An agent may send the person's limits with `book` as `mandate` (type `Mandate`). Every field is optional; leave out any limit the person didn't set.

| Field | Type | Rule |
|---|---|---|
| `priceCapCents` | integer, 0–100,000,000 | The service's price must be at most this. |
| `depositCapCents` | integer, 0–100,000,000 | The service's deposit must be at most this. |
| `window` | `{ from, to }`, RFC 3339 with offsets, `from` before `to` | The appointment, `[start, end)`, must lie inside `[from, to]`. |

- `decide()` checks them in that order; the first one broken is `outside_mandate` with `details.field` `price_cap`, `deposit_cap` or `window`, and next_action "Ask the person to widen their limit, or choose a different service or time."
- Unknown fields (in `mandate` or `window`) are refused as `invalid_request` rather than ignored, so a limit the person set is never silently dropped. `null` for a field counts as absent; `null` or `{}` for the whole mandate means none.
- The mandate is stored on the booking (`bookings.mandate`), recorded in the `booked` event, and shown on the approval page (`ApprovalView.mandate`).
- `TODO(ring-2)`: require a mandate once agents sign in.

## The booking lifecycle

| `status` | Meaning | Holds the time? |
|---|---|---|
| `awaiting_approval` | The slot is held; the person hasn't approved yet. `book` creates every booking in this status, for 10 minutes. | Yes, until the hold runs out |
| `awaiting_deposit` | Holds the slot until the deposit is paid. Not produced until Ring 1c. | Yes |
| `confirmed` | The appointment is on: the person approved it. | Yes |
| `cancelled` | Cancelled by the agent or the owner, or declined by the person. | No (final) |
| `expired` | The person didn't approve within the 10-minute hold. (Ring 1c: also a deposit not paid in time.) | No (final) |
| `completed` | The owner marked it done, after the start. | No (final) |
| `no_show` | The owner marked that the customer didn't come, after the start. | No (final) |

Only `awaiting_approval`, `awaiting_deposit` and `confirmed` count as busy time, and only they are covered by the database's `no_overlap` constraint. A hold past its deadline stops counting at once, and is marked `expired` by [lazy expiry](#lazy-expiry). A final status never changes again.

### Transitions

One pure function, `decide()` in [`lib/server/engine/lifecycle.ts`](../lib/server/engine/lifecycle.ts), decides every change, including `book` itself (the [mandate](#mandate) and the hold's deadline). "Before the start" means now < start; "after the start" means now ≥ start, so an appointment starting right now has started. The hold's deadline, `approveBy`, is the booking time + 10 minutes.

| Who | Action | From | When | Result | `depositEffect` |
|---|---|---|---|---|---|
| agent | `book` tool | (new) | within the mandate | `awaiting_approval` until now + 10 min | |
| agent | `book` tool | (new) | outside the mandate | `outside_mandate` | |
| customer | `POST …/approve` | `awaiting_approval` | before `approveBy` | `confirmed` | `none` (`TODO(ring-1c)`: `awaiting_deposit` when there's a deposit) |
| customer | `POST …/decline` | `awaiting_approval` | before `approveBy` | `cancelled` | `released` |
| customer | approve or decline | `awaiting_approval` past `approveBy`, or `expired` | any time | `approval_expired` | |
| customer | approve or decline | any other status | any time | `approval_closed` | |
| system | lazy expiry, or the [nightly tidy-up](nightly.md) | `awaiting_approval` | at or after `approveBy` | `expired` | `released` |
| agent | `cancel` tool | `awaiting_approval` | any time | `cancelled` | `released` |
| owner | `POST …/cancel` | `awaiting_approval` | any time | `cancelled` | `released` |
| owner | complete or no-show | `awaiting_approval` | any time | `invalid_request` | |
| agent | `cancel` tool | `confirmed` | start − now ≥ `cancelWindowHours` | `cancelled` | `released` |
| agent | `cancel` tool | `confirmed` | before the start, inside the window | `cancelled` | `captured` |
| agent | `cancel` tool | `confirmed` | after the start | `not_cancellable` | |
| agent | `cancel` tool | `awaiting_deposit` | any time | `cancelled` | `released` |
| agent | `cancel` tool | a final status | any time | `not_cancellable` | |
| owner | `POST …/cancel` | `awaiting_deposit` or `confirmed` | before the start | `cancelled` | `released` |
| owner | `POST …/cancel` | `awaiting_deposit` or `confirmed` | after the start | `invalid_request` | |
| owner | `POST …/complete` | `confirmed` | after the start | `completed` | `released` |
| system | the [nightly tidy-up](nightly.md) | `confirmed` | ended more than 3 hours ago | `completed` | `released` |
| owner | `POST …/no-show` | `confirmed` | after the start | `no_show` | `captured` |
| owner | complete or no-show | `confirmed` | before the start | `invalid_request` | |
| owner | complete or no-show | `awaiting_deposit` | any time | `invalid_request` | |
| owner | any | a final status | any time | `invalid_request` | |

- A booking with `depositCents: 0` always gets `depositEffect: "none"` instead of `released` or `captured`. During a hold no money is involved, so dropping it releases (the person keeps everything).
- Each actor may only take its own actions (agent: cancel; owner: cancel, complete, no-show; customer: approve, decline; system: expire, confirm a paid deposit, complete a past appointment). Anything else is `invalid_request`. The system completes by the owner's rule (a confirmed booking, after its start); the nightly tidy-up only asks once the booking ended more than 3 hours ago.
- **No money moves yet.** Every result and event says `depositCollected: false`. `TODO(ring-1c)`: hold, release and capture real deposits.
- **Transitions are atomic.** The store changes the booking only if its status is still the one `decide()` saw (`UPDATE … WHERE status = <expected>`), and writes the event in the same statement. Of two concurrent transitions only one wins; the loser re-reads the booking and gets the right error (e.g. `not_cancellable`). Approve and decline also require `approve_by` to be still ahead, in the same statement, so a hold can't be approved after it ran out.

### Events

Every state change writes exactly one event, in the same transaction, starting with the booking itself. `GET /api/shops/[shop]/bookings/[id]` lists them, oldest first.

| Field | Notes |
|---|---|
| `id` | Increasing id, as a string. Events sort by `at`, then `id`. |
| `bookingId` | The booking. |
| `at` | RFC 3339 in the shop's offset. With Postgres, the database's time (see [Freezing time](#freezing-time-frontdesk_now)). |
| `actor` | `agent`, `owner`, `customer` (the person, through the approval link) or `system` (a hold that ran out, a deposit paid or not paid in time, a past appointment the [nightly tidy-up](nightly.md) completed). |
| `type` | `booked`, `approved`, `declined`, `expired`, `cancelled`, `completed` or `no_show`. Ring 1c adds more. |
| `data` | `booked`: `{ status: "awaiting_approval", agentName, mandate? }`. A transition: `{ from, to, depositEffect, depositCollected }`. |

```json
[
  {
    "id": "1",
    "bookingId": "bd3db26a-83b1-403c-b923-357982915d3c",
    "at": "2026-11-10T11:00:00-05:00",
    "actor": "agent",
    "type": "booked",
    "data": {
      "status": "awaiting_approval",
      "agentName": "unknown agent",
      "mandate": { "priceCapCents": 5000, "window": { "from": "2026-11-14T12:00:00-05:00", "to": "2026-11-14T18:00:00-05:00" } }
    }
  },
  {
    "id": "2",
    "bookingId": "bd3db26a-83b1-403c-b923-357982915d3c",
    "at": "2026-11-10T11:02:00-05:00",
    "actor": "customer",
    "type": "approved",
    "data": { "from": "awaiting_approval", "to": "confirmed", "depositEffect": "none", "depositCollected": false }
  }
]
```

A hold nobody answered gets `{ "actor": "system", "type": "expired", "data": { "from": "awaiting_approval", "to": "expired", "depositEffect": "released", "depositCollected": false } }`.

The database also stamps `cancelled_at` and `cancelled_by` (`agent`, `owner` or `customer`), `completed_at` or `no_show_at` on the booking row. `Booking` doesn't show them; the events do.

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

### `GET /api/status` → `StatusResponse`

Public: no token, and it never shows a secret value or a connection string. Always **200**, never cached. It says what this deployment is and whether it's ready to verify; `pnpm smoke` reads it before anything else (see [VERIFIER.md](VERIFIER.md)).

```json
{
  "status": "not_ready",
  "environment": "preview",
  "commit": "abcdef0",
  "database": {
    "mode": "postgres",
    "reachable": true,
    "shopName": "Hart's Barbers (preview)",
    "writesAllowed": true,
    "schema": "outdated",
    "missing": ["approvals.token"]
  },
  "ownerAccess": "configured",
  "approvalLinks": { "origin": "https://emergent-git-my-branch.vercel.app" },
  "alerts": "log",
  "lastNightlyRun": { "ranAt": "2026-11-10T08:00:04.512Z", "expired": 1, "completed": 4, "depositsReleased": 3, "failures": 0 },
  "texting": "off",
  "problems": [
    "The database schema is outdated, missing approvals.token: rebuild the Preview database from this branch with GitHub → Actions → Preview database → Run workflow (docs/database.md)."
  ]
}
```

- `status` is `ready` exactly when `problems` is empty. Each problem is one sentence saying what to fix and where.
- `environment` is `VERCEL_ENV` (`development` when unset); `commit` is `VERCEL_GIT_COMMIT_SHA`'s first 7 characters, or `null`.
- `database.mode` is `postgres` when `DATABASE_URL` is set, else `memory`. `reachable` is whether it answered (within 8 seconds per query).
- `database.schema` is `current` only if every table and column Front Desk reads and writes exists (`REQUIRED_SCHEMA` in `lib/server/frontdesk/schema.ts`), `outdated` with `missing` naming what isn't there (`table.column`, or a bare table name), or `unknown` when the database couldn't be inspected.
- `database.writesAllowed`: never in production; elsewhere only when `shopName` ends in "(preview)" (the Preview database) or the data is in memory. A preview on a database without that mark is `not_ready`, since it might be production's.
- `ownerAccess` is whether `OWNER_API_TOKEN` is set. `approvalLinks.origin` is the request's origin: approval links are built on the origin of the request that creates them.
- `alerts` is how [owner alerts](#owner-alerts) go out: `email` when `RESEND_API_KEY` is set (Production), else `log`. Neither is a problem.
- `lastNightlyRun` is the [nightly tidy-up](nightly.md)'s newest run against this database: when it ran (UTC) and its counts. `null` when it never ran here (previews, until someone calls it), or when it can't be read. Never a problem.
- `texting` is how texts go out: `photon` (iMessage), `twilio` (SMS) or `off`, by which variables are set ([texting.md](texting.md#which-sender)). `off` is not a problem.

## Owner routes

The owner's console reads the bookings list; the other routes change the shop's rules and act on bookings.

**Auth (stub).** Every owner route needs the header `Authorization: Bearer <OWNER_API_TOKEN>`, or the `fd_owner` cookie from an [owner session](#owner-session-stub) (that's how the console calls them from the browser). Both are compared to `OWNER_API_TOKEN` with `===`, after trimming. `TODO(ring-2): owner sign-in replaces the token.`
- No header, another scheme, or the wrong token, and no cookie with the right token → **401** `unauthorized`, with `WWW-Authenticate: Bearer realm="front-desk-owner"`.
- If the deployment's `OWNER_API_TOKEN` is unset or empty, every owner request is **401** with next_action `"Owner access isn't set up: set OWNER_API_TOKEN in Vercel and redeploy."` An empty token never matches an empty header. Setting it up is in [database.md](database.md#4-set-owner_api_token).
- The token is checked first, before the request touches the database. It's read from the environment on every request and never logged or echoed.

```json
{ "error": { "code": "unauthorized", "message": "Missing or wrong owner token.", "next_action": "Send the header Authorization: Bearer <OWNER_API_TOKEN>." } }
```

```json
{ "error": { "code": "unauthorized", "message": "Owner access isn't set up on this deployment.", "next_action": "Owner access isn't set up: set OWNER_API_TOKEN in Vercel and redeploy." } }
```

### `GET /api/shops/[shop]/bookings` → `BookingsResponse`

The owner's bookings list; `/console` reads it. **An owner route** (it shows customers' phone numbers): Bearer token or the `fd_owner` cookie. Its 401 says `"Open /console/unlock and enter the shop's access code."`, which the console shows.

Bookings of any status whose time overlaps the range from 7 days ago to 30 days ahead, sorted by `start`, after expiring lapsed holds in that range ([lazy expiry](#lazy-expiry)). Each item is a `Booking`, the same shape `book` returns. Holds show `status: "awaiting_approval"` with their `approval` link, for the owner to copy; approved bookings show `customer.approved: true` and `customer.phone` when the person gave one.

```bash
curl -s http://localhost:3000/api/shops/harts/bookings -H "Authorization: Bearer $OWNER_API_TOKEN"
```

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
      "customer": { "displayName": "Maya", "approved": true, "phone": "+14015550123" },
      "agent": { "name": "unknown agent" },
      "depositCents": 1000,
      "createdAt": "2026-11-10T10:00:00-05:00"
    },
    {
      "id": "bd3db26a-83b1-403c-b923-357982915d3c",
      "shopSlug": "harts",
      "serviceId": "beard-trim",
      "serviceName": "Beard trim",
      "staffId": "dana",
      "start": "2026-11-14T16:00:00-05:00",
      "end": "2026-11-14T16:15:00-05:00",
      "display": "Sat 14 Nov, 4:00 pm EST",
      "status": "awaiting_approval",
      "customer": { "displayName": "Lee", "approved": false },
      "agent": { "name": "unknown agent" },
      "depositCents": 0,
      "createdAt": "2026-11-10T11:00:00-05:00",
      "approval": {
        "url": "http://localhost:3000/approve/rnIpjP-nfqeF8V1kZsQTh2C4wX5uit8mcySiGndv3OM",
        "expiresAt": "2026-11-10T11:10:00-05:00"
      }
    }
  ]
}
```


### Owner session (stub)

The owner enters the shop's access code (`OWNER_API_TOKEN`) once at **`/console/unlock`**; the server answers with an HttpOnly cookie holding it, and every owner route accepts that cookie. `/console` forwards the browser's cookie to the bookings list, so it works with no token in page code. Where texting is on, the owner can instead ask for a 6-digit code by text (`POST /api/owner/code`) and send it as `{ "code": "…" }`: it sets the same cookie. See [texting.md](texting.md#3-owner-sign-in-by-texted-code).

| Method and path | Request | Response | Success |
|---|---|---|---|
| `POST /api/owner/session` | `OwnerSessionRequest` `{ "token": "…" }` as JSON | `OwnerSessionResponse` `{ "signedIn": true, "expiresAt": "…" }`, plus `Set-Cookie: fd_owner=…` | 200 |
| `POST /api/owner/session` | a form post with a `token` field (what `/console/unlock` sends) | `Set-Cookie: fd_owner=…` and `Location: /console` | 303 |
| `POST /api/owner/session` | `{ "code": "042917" }` as JSON, or a form post with a `code` field: a code from `POST /api/owner/code` ([texting](texting.md#3-owner-sign-in-by-texted-code)) | the same cookie; a wrong, used or expired code → 401 (form: 303 → `/console/unlock?error=code`) | 200 / 303 |
| `POST /api/owner/code` | no body | `OwnerCodeResponse`: a code texted to `ownerMobile`, valid 10 minutes, once (form: 303 → `/console/unlock?code=sent`) | 200 / 303 |
| `GET /api/owner/session` | | `OwnerSessionResponse`: `{ "signedIn": true }` or `{ "signedIn": false }` | 200 |
| `DELETE /api/owner/session` | | `OwnerSessionResponse` `{ "signedIn": false }`, plus a `Set-Cookie` that clears `fd_owner` | 200 |

**`POST`** compares `token` to `OWNER_API_TOKEN` exactly like the bearer check:
- The right token → the cookie `fd_owner=<the token, URI-encoded>; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure`. `Secure` is left off only for plain http on `localhost` (and `127.0.0.1`, `[::1]`) off Vercel, so `pnpm dev` works in every browser. It lasts 12 hours; changing the token ends every session.
- JSON: the right token → 200 with `expiresAt`; the wrong token → **401** `unauthorized` (`"Wrong owner token."`), no cookie; a body that isn't `{ "token": "<string>" }` → **400** `invalid_request` with `details.field`; `OWNER_API_TOKEN` not set → **401** with the "isn't set up" next_action.
- Form post: the right token → **303** → `/console` with the cookie; a wrong or missing token (or none set) → **303** → `/console/unlock?error=1`, which shows "That access code didn't work."

**`GET`** says whether this browser holds a cookie with the right token. It can't know when the cookie expires, so it never includes `expiresAt`.

**`DELETE`** signs out: it always answers 200 and clears the cookie. It needs no auth.

**Using the cookie on owner routes.** Every owner route accepts the cookie, for any method, exactly like the bearer token.

From the console (same origin, so the browser sends and stores the cookie by itself):

```ts
import type { OwnerSessionRequest, OwnerSessionResponse } from "@/lib/types/frontdesk";

const json = { "Content-Type": "application/json" };

// On load: unlocked already?
const session = (await (await fetch("/api/owner/session")).json()) as OwnerSessionResponse;
// Unlock: 200 sets the cookie; 401 wrong token. (Or a plain <form method="post" action="/api/owner/session">.)
await fetch("/api/owner/session", { method: "POST", headers: json, body: JSON.stringify({ token } satisfies OwnerSessionRequest) });
// Owner routes: the browser sends the cookie.
await fetch("/api/shops/harts/policies", { method: "PUT", headers: json, body: JSON.stringify({ paused: true }) });
// Sign out.
await fetch("/api/owner/session", { method: "DELETE" });
```

With curl:

```bash
curl -s -c jar.txt -X POST http://localhost:3000/api/owner/session \
  -H "Content-Type: application/json" -d "{\"token\":\"$OWNER_API_TOKEN\"}"
curl -s -b jar.txt http://localhost:3000/api/owner/session
curl -s -b jar.txt http://localhost:3000/api/shops/harts/bookings
curl -s -b jar.txt -X PUT http://localhost:3000/api/shops/harts/policies \
  -H "Content-Type: application/json" -d '{"paused":false}'
curl -s -b jar.txt -c jar.txt -X DELETE http://localhost:3000/api/owner/session
```

### Routes

| Method and path | Request | Response | Success |
|---|---|---|---|
| `GET /api/shops/[shop]/bookings` | | `BookingsResponse` | 200 |
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
| `GET /api/shops/[shop]/alerts` | | `AlertsResponse` | 200 |

Other statuses: **400** `invalid_request`, **401** `unauthorized` (including no `OWNER_API_TOKEN` set), **404** `not_found` (shop, staff member, service, blocked time) or `booking_not_found`, **500** `internal`.

**Validation.** Request bodies are checked with zod:
- The body must be a JSON object. An empty body or invalid JSON is 400 with `details.field: "body"`.
- Unknown fields are rejected.
- Text can't contain the NUL character (U+0000), which Postgres can't store: `phone`, `ownerEmail`, the three rules, a service's `id` and `name`, a block's `reason`, and `staffId`. A shop slug, service id or booking id in the path that contains it is simply 404.
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

`GET` returns the shop and its policies (`PoliciesResponse`: the shape of `get_policies`, plus `ownerEmail`). `PUT` changes some of them.

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
| `ownerEmail` | An email address with an `@`, at most 254 characters, or `null` to remove it. Where [owner alerts](#owner-alerts) are emailed. Nothing else is checked: Resend refuses what it can't send to, and the alert is recorded as `failed` with its message. |
| `ownerMobile` | A mobile number in E.164 (spaces, dashes, dots and parentheses are ignored; stored without them), or `null` to remove it. Where texting is on, owner alerts are also texted here and the sign-in code goes here ([texting.md](texting.md)). |

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
    "noShowRule": "If you don't show up, we keep the deposit. Otherwise it is released after your appointment.",
    "ownerEmail": null,
    "ownerMobile": null
  }
}
```

Set where alerts go:

```bash
curl -s -X PUT http://localhost:3000/api/shops/harts/policies \
  -H "Authorization: Bearer $OWNER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"ownerEmail": "dana@example.com"}'
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

`POST /api/shops/[shop]/bookings/[id]/cancel`, `/complete` and `/no-show` apply the [transition table](#transitions) with actor `owner`. They take no body (one is ignored). They write one event each. A hold awaiting approval can be cancelled any time (its approval link then shows `expired`), but not completed or marked a no-show (400). A hold that ran out is expired first, like every read.

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
    "customer": { "displayName": "Sam", "approved": true, "phone": "+14015550199" },
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
    "customer": { "displayName": "Sam", "approved": true, "phone": "+14015550199" },
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
      "data": { "status": "awaiting_approval", "agentName": "unknown agent" }
    },
    {
      "id": "8",
      "bookingId": "5e4cd04c-c8d2-4c5f-aa75-b58d2389e3cc",
      "at": "2026-11-10T10:00:00-05:00",
      "actor": "customer",
      "type": "approved",
      "data": { "from": "awaiting_approval", "to": "confirmed", "depositEffect": "none", "depositCollected": false }
    },
    {
      "id": "9",
      "bookingId": "5e4cd04c-c8d2-4c5f-aa75-b58d2389e3cc",
      "at": "2026-11-10T10:00:00-05:00",
      "actor": "owner",
      "type": "no_show",
      "data": { "from": "confirmed", "to": "no_show", "depositEffect": "captured", "depositCollected": false }
    }
  ]
}
```

## Owner alerts

The owner hears about every booking that is confirmed or cancelled, and every alert is recorded, so it can be checked without reading anyone's inbox.

| `kind` | When | Sent by |
|---|---|---|
| `booking_confirmed` | The person approved a booking (`POST /api/approvals/[token]/approve`). | `approveBooking` (`lib/server/consent/approvals.ts`) |
| `booking_cancelled` | The agent cancelled a confirmed booking or a hold (`cancel`), or the person declined a hold (`POST …/decline`). | `cancelBooking` (`lib/server/frontdesk/service.ts`), `declineBooking` |

No alert for a hold on its own, a hold that lapses, or anything the owner does themselves (their cancel, complete or no-show).

**Channel.** Picked per alert (`createNotifier` in `lib/server/notify/notifier.ts`):
- `email` when `RESEND_API_KEY` is set **and** the shop has an `ownerEmail` ([Policies](#policies)). One plain-text email through Resend's HTTP API, from `Front Desk <onboarding@resend.dev>` (`TODO(ring-3)`: the shop's own domain). With that shared sender, **Resend only delivers to the Resend account's own email address**, so the account must be created with the address the owner's alerts go to.
- `log` everywhere else: one JSON line in the function log (Vercel → Logs), e.g. `{"event":"booking.confirmed","id":"…","shop":"harts","service":"haircut","start":"…","customer_first_name":"Maya","subject":"New booking: Haircut, Sat 14 Nov 2:30 pm"}`. It has the customer's first name only. Previews have no `RESEND_API_KEY`, so their alerts are always logged.

`/api/status` says which (`"alerts": "email"` or `"log"`); neither is a problem.

**By text, too.** Where texting is on (`/api/status` `"texting"` isn't `"off"`) and the shop has an `ownerMobile`, each alert is also texted there, and recorded as a second alert with `channel: "text"` (`recipient` the number; `sent` or `failed`). The email or log alert is unchanged. See [texting.md](texting.md#2-owner-alerts-by-text).

**When.** After the change is committed, before the response. A failed alert never changes the booking or the answer: Resend refusing the email or not answering within 8 seconds is recorded with `status: "failed"` and the error, and logged as `booking.notify_failed`. There are no retries (`TODO(ring-2)`).

**The email** (fewer than 15 lines; times in the shop's zone):

```
Subject: New booking: Haircut, Sat 14 Nov 2:30 pm

New booking at Hart's Barbers: the customer approved it.

Service: Haircut
When: Sat 14 Nov, 2:30 pm EST
Customer: Maya Lopez
Phone: +14015550123
Booked by: claude-ai
Price: $35 (deposit $10, not collected yet)

All bookings: https://<origin>/console
```

A cancellation's subject is `Cancelled: Haircut, Sat 14 Nov 2:30 pm`, and its first line is `The agent cancelled a booking at Hart's Barbers. The time is free again.` or `The customer declined a booking at Hart's Barbers. The time is free again.` The phone line appears only when the person gave one. `<origin>` is the deployment that served the approval, decline or cancel.

### `GET /api/shops/[shop]/alerts` → `AlertsResponse`

**An owner route**: Bearer token or the `fd_owner` cookie. Like the bookings list, its 401 says `"Open /console/unlock and enter the shop's access code."`. It returns the shop's newest 50 alerts, newest first, whatever happened to them (`sent`, `logged` or `failed`).

```bash
curl -s http://localhost:3000/api/shops/harts/alerts -H "Authorization: Bearer $OWNER_API_TOKEN"
```

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "alerts": [
    {
      "id": "12",
      "shopSlug": "harts",
      "bookingId": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
      "kind": "booking_cancelled",
      "channel": "email",
      "recipient": "dana@example.com",
      "status": "failed",
      "error": "Resend answered HTTP 403: You can only send testing emails to your own email address (owner@example.com).",
      "createdAt": "2026-11-10T10:05:00-05:00"
    },
    {
      "id": "11",
      "shopSlug": "harts",
      "bookingId": "632aa35c-4e9e-4a08-8880-b5b1165939e2",
      "kind": "booking_confirmed",
      "channel": "log",
      "recipient": null,
      "status": "logged",
      "error": null,
      "createdAt": "2026-11-10T10:01:00-05:00"
    }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | Increasing. Newest first: by `createdAt`, then `id`. |
| `channel` | `email` or `log`. `recipient` is the address for `email`, `null` for `log`. |
| `status` | `sent` (Resend accepted the email), `logged` (the log line was written) or `failed` (`error` says why; `null` otherwise). |
| `createdAt` | When it was sent, in the shop's zone. Set by the database, like event times (see [database.md](database.md#database-time-and-frontdesk_now)). |

## Try the full loop

Start the app. With `DATABASE_URL` set (see [database.md](database.md)), bookings go to Postgres. Without it, they go to an in-memory store that resets when the server restarts. Put an owner token in `.env.local` (git-ignored) so the owner routes work:

```bash
echo "OWNER_API_TOKEN=$(openssl rand -hex 32)" >> .env.local
FRONTDESK_NOW=2026-11-10T10:00:00-05:00 pnpm dev
```

Approval links use the origin you call `/api/mcp` on, so another port just works.

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

# 4. Book one of the returned starts → awaiting_approval and an approval link
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Maya
B=<the booking id from the text>
T=<the token at the end of the approval link>
$I --method tools/call --tool-name get_booking --tool-arg booking_id=$B   # → the same link again

# 5. The same slot again while it's held → slot_taken, with details.alternatives (1:45, 2:00 and 3:00 pm)
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Jo

# 6. Maya opens http://localhost:3000/approve/$T and taps Approve. With curl: the view, then approve
#    (the phone is optional)
A=http://localhost:3000/api/approvals/$T
curl -s $A
curl -s -X POST $A/approve -H "Content-Type: application/json" -d '{"phone":"+14015550123"}'
$I --method tools/call --tool-name get_booking --tool-arg booking_id=$B   # → confirmed, customer.approved true

# 7. A haircut a week ahead → too_far (details.latest is 2026-11-16T10:00:00-05:00)
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-17T10:00:00-05:00 --tool-arg customer_name=Jo

# 8. The owner's list (what /console shows): the booking, with customer.approved true and customer.phone
curl -s $O/bookings -H "$AUTH"

# 9. Cancel it, 4 days ahead → cancelled, depositEffect "released", depositCollected false
$I --method tools/call --tool-name get_booking --tool-arg booking_id=$B
$I --method tools/call --tool-name cancel --tool-arg booking_id=$B

# 10. The owner's view: booked (agent), approved (customer), then cancelled (agent); and the owner's
#     alerts for it: booking_cancelled, then booking_confirmed (by log, logged, without RESEND_API_KEY;
#     the dev server's terminal shows the log lines)
curl -s $O/bookings/$B -H "$AUTH"
curl -s $O/alerts -H "$AUTH"

# 11. The owner pauses bookings → get_availability returns nothing and book returns paused
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"paused": true}'
$I --method tools/call --tool-name get_availability \
  --tool-arg service_id=haircut --tool-arg from=2026-11-14T00:00:00-05:00 --tool-arg to=2026-11-15T00:00:00-05:00
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-14T14:30:00-05:00 --tool-arg customer_name=Maya
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"paused": false}'

# 12. A no-show needs a confirmed booking whose start has passed. With the clock frozen, set the lead
#     time to 0, book the frozen "now" itself (Tue 10 Nov, 10:00 am), and approve it as above.
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"leadTimeMin": 0}'
$I --method tools/call --tool-name book \
  --tool-arg service_id=haircut --tool-arg start=2026-11-10T10:00:00-05:00 --tool-arg customer_name=Sam
P=<the booking id from the text>
curl -s -X POST http://localhost:3000/api/approvals/<its token>/approve
curl -s -X POST $O/bookings/$P/no-show -H "$AUTH"      # → no_show, depositEffect "captured"
curl -s $O/bookings/$P -H "$AUTH"                      # → booked, approved, then no_show by the owner

# 13. A hold nobody answers: book, then restart with the clock 11 minutes on
#     (FRONTDESK_NOW=2026-11-10T10:11:00-05:00 pnpm dev). Postgres keeps the hold across the restart.
#     get_availability offers the time again; get_booking says expired; a new book for it succeeds.
curl -s -X PUT $O/policies -H "$AUTH" -H "Content-Type: application/json" -d '{"leadTimeMin": 120}'
```

After step 4, `get_availability` no longer offers 2:15, 2:30 or 2:45 pm (the hold covers them). After step 9 it offers them again. With Postgres, the owner's changes persist, so step 11 and 12 put them back. Run the loop on a fresh database (or the in-memory store) to get the same results.

## Demo data

The seed ([`supabase/seed.sql`](../supabase/seed.sql)) has one shop, and the in-memory store has the same data:
- Hart's Barbers has one staff member, Dana (`dana`), who works Tue–Sat 9:00–12:00 and 12:30–17:00. The gap is lunch. It's closed Sunday and Monday.
- It has three services. Haircut and Haircut + beard trim take a $10 deposit; Beard trim doesn't.
- Its policies: book at least 2 hours ahead; up to 30 days ahead, or 6 days for a service with a deposit; cancel at least 24 hours ahead for the deposit to be released. Phone `+1 212-555-0142`. Not paused. The three plain-language rules are in the `get_policies` example above.
- A Postgres database starts with no bookings and no blocked times, and so does the in-memory store.

### Freezing time: `FRONTDESK_NOW`

Set `FRONTDESK_NOW` to an RFC 3339 instant to freeze Front Desk's clock. Demos are then reproducible, because everything that depends on "now" is computed from that instant: the lead time, the horizons, which starts are past, the cancellation window, whether an appointment has started, and the hold's 10 minutes. To see a hold expire, restart with `FRONTDESK_NOW` more than 10 minutes later.

```bash
FRONTDESK_NOW=2026-11-10T10:00:00-05:00 pnpm dev
```

What it doesn't freeze depends on the store:
- **Postgres:** `createdAt`, event times (`at`) and the lifecycle timestamps are the database's real time (`now()`).
- **In-memory store:** those use the frozen clock too, so `createdAt` and event times show the frozen instant.

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

`book` returns an approval link: open it in a browser, or use the curl commands in [Try it with curl](#try-it-with-curl).

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

Then ask, for example: *"What haircut times does Hart's Barbers have this Saturday?"*, then *"Book the 2:30 for Maya."* Claude gets an approval link to give you; open it on your phone and tap Approve. Then *"Is it confirmed?"* or *"Actually, cancel it."*

Vercel Deployment Protection on preview URLs blocks outside clients like Claude. To test a preview from Claude, use a protection-bypass link, or test on production after merge.

## Not built yet

These are marked `TODO(ring-N)` in the code:

| Ring | Item | Where |
|---|---|---|
| ring-1c | Collect deposits and move money (`depositEffect` is the policy's decision; `depositCollected` is always `false`) | `lib/server/frontdesk/service.ts` (`book`, `transitionBooking`), `lib/server/engine/lifecycle.ts` |
| ring-1c | `awaiting_deposit`: approval confirms a booking even when its service has a deposit, until deposits come with Stripe | `lib/server/engine/lifecycle.ts` (`decideAnswer`), `lib/server/consent/approvals.ts` (`approveBooking`), `lib/server/frontdesk/service.ts` (`book`) |
| ring-1c | A code texted to the person's phone (Photon iMessage, Resend as a fallback) comes back once real texting ships; today the link alone is the consent | `lib/server/consent/approvals.ts`, `lib/types/frontdesk.ts` (approval page types), `supabase/migrations/0003_consent.sql` |
| ring-2 | Retry owner alerts that failed (today a failed email is only recorded as `failed`) | `lib/server/frontdesk/service.ts` (`alertOwner`) |
| ring-3 | Send owner alerts from the shop's own domain instead of Resend's onboarding sender (which only delivers to the Resend account's own address) | `lib/server/notify/email.ts` (`ALERT_FROM`) |
| ring-2 | Let agents pick the shop (by slug or URL) instead of hard-coding Hart's | `lib/server/frontdesk/mcp.ts` (`DEFAULT_SHOP_SLUG`) |
| ring-2 | Owner sign-in replaces `OWNER_API_TOKEN` and the `fd_owner` cookie | `lib/server/frontdesk/owner-auth.ts`, `lib/server/frontdesk/owner-session.ts`, `app/api/owner/session/route.ts`, `lib/server/frontdesk/http.ts`, the owner route files |
| ring-2 | MCP sign-in: authenticate callers (`book` and `cancel` are open to anyone) | `app/api/mcp/route.ts` |
| ring-2 | A signed-in agent identity instead of the self-reported client name | `lib/server/frontdesk/mcp.ts` (`agentNameFrom`) |
| ring-2 | `get_booking` and `cancel` still trust anyone holding the booking id; agent identity fixes this | `lib/server/frontdesk/service.ts` (`getBooking`, `cancelBooking`), `app/api/mcp/route.ts` |
| ring-2 | Require a mandate once agents sign in | `lib/server/engine/lifecycle.ts` (`decide`, book), `lib/server/frontdesk/service.ts` (`book`), `lib/types/frontdesk.ts` (`Mandate`) |
| ring-2 | OAuth or connector sign-in for agents (Ring 1b deliberately needs none) | `app/api/mcp/route.ts` |

A UI for any of this is v0's lane. The approval page (`app/approve/[token]/page.tsx`) and the unlock page (`app/console/unlock/page.tsx`) are plain stand-ins until v0 restyles them.
