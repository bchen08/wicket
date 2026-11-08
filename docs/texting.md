# Texting

Front Desk can send text messages. When a text sender is configured, three things happen by text:

1. **The approval link goes to the person.** An agent that books with the person's mobile number (MCP `customer_phone`, web `phone`) gets the link texted to that number. The result says so (`texted: true`), so the agent doesn't send it again.
2. **The owner gets every alert on their phone.** Every [owner alert](frontdesk-api.md#owner-alerts) (a new booking, or a cancellation) is also texted to the shop's `ownerMobile`. The email or log line still goes out exactly as before.
3. **The owner can sign in with a texted code.** "Text me a code" on `/console/unlock` texts a 6-digit code to `ownerMobile`. The code opens the console, just like the access code.

**Without a text sender, nothing changes.** Nothing is texted. Agents send the link themselves (`texted: false`), alerts go by email or log, and the owner unlocks with the access code. `/api/status` says `"texting": "off"`, which is not a problem.

Types are in [`lib/types/texting.ts`](../lib/types/texting.ts). The code lives in [`lib/server/notify/`](../lib/server/notify) (`texting.ts`, `text-sender.ts`, `photon.ts`, `twilio.ts`, `texts.ts`) and [`lib/server/frontdesk/owner-code.ts`](../lib/server/frontdesk/owner-code.ts).

## Which sender

One interface (`TextSender` in `text-sender.ts`), two implementations. The environment decides which one runs, by which variables are set (`textingMode` in `texting.ts`):

| Variables set (all of them) | Sender | `/api/status` `texting` |
|---|---|---|
| `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_LINE` | Photon: iMessage | `photon` |
| otherwise `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio: SMS | `twilio` |
| neither set (or only some of a sender's variables) | none | `off` |

Photon wins when both are set. Values are trimmed, and a blank value counts as unset. Set them in Vercel for **Production** only, so previews never text anyone.

### Photon (iMessage)

Photon's HTTP API is at `https://api.photon.codes` (its "Beta" API). `photon.ts` calls it with plain `fetch`. There's no SDK: Photon's SDKs hold a long-lived gRPC connection, which a serverless function can't keep. Every call sends `Authorization: Bearer $PHOTON_API_KEY`.

| Variable | What |
|---|---|
| `PHOTON_API_KEY` | A project API key, `pho_sk_…` (Photon → the project → API keys). It needs the `platforms:read` permission for the line lookup below. |
| `PHOTON_PROJECT_ID` | `pho_prj_…`. |
| `PHOTON_LINE` | The iMessage line to send from when Photon has **no assigned line** for the person, E.164 (e.g. `+12125550100`). On a dedicated line, this is the dedicated number. |

**Each person has their own line.** Photon's shared iMessage pairs each person with their own line from the project's pool. A text from any other line doesn't reach them, so every text goes out from the line assigned to that person. `PHOTON_LINE` is used only if Photon returns no assignment for them.

One text takes up to five calls (more if call 1's list runs over several pages):

1. `GET /v1/projects/{project}/platforms/imessage/assignments?pageSize=200` lists the project's active assignments as `{ "assignments": [{ "handle", "assignedPhoneNumber", … }], "nextPageToken"? }`. Photon can't filter this list by person, so `photon.ts` follows `nextPageToken` until it finds the `handle` equal to the person's number. That entry's `assignedPhoneNumber` is the line. This runs on every text, so someone added in Photon's dashboard is picked up right away.
2. `POST /v1/projects/{project}/users` with `{ "platform": "imessage", "handle": <the line> }` returns the line's User id. This happens once per line per server process, and the id is remembered after that.
3. The same call with the person's number returns their User id.
4. `POST /v1/projects/{project}/spaces` with `{ "platform": "imessage", "participantIds": [line, person] }` returns the chat.
5. `POST /v1/projects/{project}/messages` with `{ "spaceId", "senderId", "content": { "type": "text", "format": "plain", "text" } }` sends the text. Photon answers 202.

Calls 2–4 are "create or get": they return the existing User or chat if there is one. Photon requires an `Idempotency-Key` header on calls 4 and 5, so each call sends a fresh random UUID. That's Photon's requirement, not a retry scheme of ours. Errors come back as `application/problem+json`, and the alert or log shows them as `Photon answered HTTP 403: SHARED_LINE_INBOUND_REQUIRED: …`.

If the lookup itself fails (a refusal such as 403 `INSUFFICIENT_SCOPE`, or no answer), the text fails. It doesn't fall back to `PHOTON_LINE`, because a failed lookup doesn't mean the person has no line.

**To add someone on a shared line:**
1. Add them in Photon's dashboard with their phone number, in E.164. An iMessage email address won't match the number Front Desk texts. Photon assigns them a line from the pool.
2. They send one iMessage to their assigned line.
3. Texts to their number now arrive from that line.

**Photon's limits** (from its docs, Nov 2026):
- **Only a dedicated line can text someone first.** A shared line (the Free and Pro plans) sends only in one-to-one chats, and only to a person assigned to that line who has texted it since the assignment. Otherwise Photon refuses, for example 403 `SHARED_LINE_NOT_ASSIGNED` or `SHARED_LINE_INBOUND_REQUIRED`. A number that isn't in the project, or hasn't texted its line, fails cleanly: `texted: false`, so the agent sends the link. Owner texts need the same two steps for `ownerMobile`. A dedicated line is Photon's Business plan.
- **No SMS fallback switch.** Photon's send call has no "fall back to SMS" option, and its HTTP API has no "is this number on iMessage?" check. Whether a number without iMessage still gets the text is up to Photon and Apple, not this code. If that matters, use Twilio (SMS reaches every mobile).

### Twilio (SMS)

`twilio.ts` makes one form-encoded `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`, with Basic auth `AccountSid:AuthToken` and the fields `To`, `Body`, and `From` (or `MessagingServiceSid`).

| Variable | What |
|---|---|
| `TWILIO_ACCOUNT_SID` | `AC…`. |
| `TWILIO_AUTH_TOKEN` | The account's auth token. |
| `TWILIO_FROM` | The Twilio number to send from, E.164, or a Messaging Service SID (`MG…`), which is sent as `MessagingServiceSid`. |

Errors show Twilio's own message, e.g. `Twilio answered HTTP 400: The 'To' number +1… is not a valid phone number.` To deliver to US phones, Twilio requires the sending number to be registered (A2P 10DLC, or a verified toll-free number). That's set up in Twilio, not here.

Both senders give the provider 8 seconds to answer. There are no retries (`TODO(ring-2)`).

## 1. The approval link by text

`book` (MCP) takes an optional `customer_phone`, and `POST /api/shops/[shop]/book` (web, JSON or form) takes an optional `phone`. The number is the person's mobile, in E.164. Spaces, dashes, dots and parentheses are dropped, so `+1 (401) 555-0123` is stored as `+14015550123`. Anything that still isn't E.164 is refused with `invalid_request`, `details.field: "customer_phone"` (web: `"phone"`), and nothing is held.

- The number is **stored on the booking** (`bookings.customer_phone`; `Booking.customer.phone`), whether or not texting is on. If the person gives a number when approving, it replaces this one.
- Where texting is on, once the hold is stored, `book` texts:

  ```
  claude-ai asked Hart's Barbers to book Haircut on Sat 14 Nov, 2:30 pm EST for you. Approve or decline: https://…/approve/<token>
  ```

  The text names the agent, the shop, the service, the time in the shop's zone, and the approval link (on the origin of the request that booked).
- **The result says whether it was texted:** `BookResult.texted` (MCP structuredContent) and `WebBookResponse.texted`.
  - `true`: Front Desk texted the link. The text content and the web `next_action` tell the agent not to send it again (and still include the link, in case the person asks).
  - `false`: no phone was given, texting is off, or the text didn't go through. The agent sends `booking.approval.url` as before.
- A text that doesn't go through never fails the booking. The hold is stored by then, so failing would make the agent retry into `slot_taken`. The failure is logged as `booking.approval_text_failed` (with the booking id and the provider's error, not the number).

## 2. Owner alerts by text

`Policies.ownerMobile` is the owner's mobile, E.164, or `null`. Set it with the owner's `PUT /api/shops/[shop]/policies` (`{ "ownerMobile": "+1 212 555 0199" }`, normalized like the phone above; `null` clears it). Only the owner routes show it. `get_policies` and the booking page leave it out, like `ownerEmail`.

Where texting is on and the shop has an `ownerMobile`, every owner alert is also texted (`alertOwner` in `service.ts`):

```
New booking: Haircut, Sat 14 Nov 2:30 pm, Maya Lopez (booked by claude-ai). All bookings: https://…/console
Cancelled: Haircut, Sat 14 Nov 2:30 pm, Maya Lopez (the customer declined). All bookings: https://…/console
Cancelled: Haircut, Sat 14 Nov 2:30 pm, Maya Lopez (claude-ai cancelled). All bookings: https://…/console
```

Each text is recorded as one more alert, `channel: "text"`, `recipient` the mobile number, and `status` `sent` or `failed` (with the provider's error). It sits next to the email or log alert, which is unchanged. The owner's alerts list (`GET /api/shops/[shop]/alerts`) shows both. Texts go out for the same events as emails: a booking the person approved, the agent's cancel, the person's decline. Nothing is texted for the owner's own actions or a lapsed hold.

## 3. Owner sign-in by texted code

Only where texting is on and the shop has an `ownerMobile`. The access code (`OWNER_API_TOKEN`) keeps working everywhere.

| Method and path | Request | Response |
|---|---|---|
| `POST /api/owner/code` | no body (JSON, or a form post) | 200 `OwnerCodeResponse` `{ "sent": true, "sentTo": "•••• 0199", "expiresAt": "…Z" }`; form post → 303 `/console/unlock?code=sent` |
| `POST /api/owner/session` | `{ "code": "042917" }` (JSON), or a form post with a `code` field | 200 `OwnerSessionResponse` plus the `fd_owner` cookie; form post → 303 `/console` |

- **`POST /api/owner/code`** makes a random 6-digit code, stores it, and texts `042917 is your Front Desk code for Hart's Barbers. It works once, for 10 minutes.` to `ownerMobile`. If it can't, `details.reason` (or the unlock page's `?error=`) says why:
  - `texting_off`: no text sender is configured. 400 `invalid_request`.
  - `no_mobile`: the shop has no `ownerMobile`. 400 `invalid_request`.
  - `send_failed`: the provider refused the text. 500 `internal`. The answer shows only the masked number; the provider's message goes to the log (`owner.code_text_failed`).
- **`POST /api/owner/session` with `code`** signs in if the code is the shop's, unused, and less than 10 minutes old. It sets the same cookie as the access code (it holds `OWNER_API_TOKEN`, so the access code must be set on the deployment). The code is then used up.
  - A wrong, used or expired code gets 401 `unauthorized` (`"Wrong or expired code, or it was already used."`), and a form post gets 303 `/console/unlock?error=code`. Spaces inside the code are ignored.
  - A JSON `code` that isn't a string gets 400. Without `OWNER_API_TOKEN` the answer is the usual 401 "isn't set up", and the code is **not** used up.
- **One shop:** codes go to Hart's (`OWNER_SHOP_SLUG = "harts"`), like the MCP tools. `TODO(ring-2)`: per-shop owners.
- **Storage:** the `owner_codes` table holds `code`, `sent_to`, `expires_at` and `used_at`, stored as they are. Redeeming is one `UPDATE … WHERE used_at IS NULL AND expires_at > now`, so of two requests with the same code, only one signs in.

**The unlock page** (`app/console/unlock/page.tsx`). Where texting is on, it adds a plain "Text me a code" button under the access-code form. After it's tapped, the page says the code was sent and shows a "Code from the text" field. The page explains each `?error=`. Where texting is off, the page is exactly the access-code form it was. v0 restyles it later.

## Database (`0007_texting.sql`)

The migration is additive only:
- `policies.owner_mobile`: nullable, checked E.164.
- `alerts.channel` accepts `'text'` (the check is replaced).
- A new `owner_codes` table (`id`, `shop_slug`, `code` (six digits), `sent_to`, `expires_at`, `used_at`, `created_at`), with RLS on and no policies.

`bookings.customer_phone` already existed (0003). `book` now writes it too. All of these are in `REQUIRED_SCHEMA`, so `/api/status` names anything missing. See [database.md](database.md).

## Security not built (MVP)

These are on purpose, per the MVP rule in AGENTS.md:
- `POST /api/owner/code` has no rate limit. Anyone can make Front Desk text the owner a code, as often as they like, which spends provider credit and could annoy the owner.
- Codes have no attempt limit or lockout. Six digits with ten minutes per code can be guessed by a determined script.
- Codes are stored as plain text.
- `customer_phone` isn't verified. An agent can make Front Desk text an approval link to any number. The link only lets that number approve or decline that one hold.

## Tests

- `lib/server/notify/texting.test.ts`: which sender the environment picks, and exactly what each sender sends, using a fake fetch:
  - Photon: the lookup of the person's assigned line (across pages), the fallback to `PHOTON_LINE` only when there's no assignment, a failed lookup failing the text, the four calls after it, the Bearer key, the idempotency keys, and that each line's user is remembered.
  - Twilio: the form fields, Basic auth, and `MessagingServiceSid`.
  - How refusals surface, and what each text says.
- `lib/server/frontdesk/texting.test.ts`: everything end to end on the in-memory store, with a stubbed sender (`recordingTexter` / `failingTexter` in `test-support.ts`):
  - The link is texted and flagged through MCP, web JSON and web form posts.
  - A failed or invalid phone doesn't hold anything wrongly.
  - Through the real Photon sender against a fake shared pool: a person gets the link from their own assigned line, and a number that isn't in the project gets `texted: false`.
  - Owner alerts are texted and recorded, including a failed text.
  - `ownerMobile` works through the PUT and stays hidden from agents.
  - A code is sent, accepted once, accepted at 9:59, and refused at 10:00.
  - The unlock forms work.
  - Texting off changes nothing.
- `lib/server/frontdesk/postgres-store.test.ts` (with `DATABASE_URL_TEST`): `customer_phone` is written at insert, text alerts are stored, the `owner_mobile` check holds, and `owner_codes` codes redeem once, including two racing requests.
- `scripts/smoke-checks/texting.test.mjs`: the smoke checks below.

`pnpm smoke` runs `scripts/smoke-checks/texting.mjs` (T1–T4 in [SMOKE.md](../SMOKE.md#texting)).
