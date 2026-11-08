# Agent identity (PAP 0.4)

Front Desk knows which agent is booking when the agent speaks **PAP 0.4** (the [Personal Agent Protocol](https://github.com/personal-agent-protocol/personal-agent-protocol), "Poppy"). Such an agent signs every MCP request with a `Poppy-Session` header. Front Desk verifies it and records the agent. The agent's bookings then show it as **confirmed**, under the name in its signed client metadata.

Agents without PAP keep booking exactly as before. This covers Claude, ChatGPT, MCP Inspector, the web booking API and the booking page. Their bookings carry a self-reported name and show as **unconfirmed**.

Spec: PAP draft 0.4 at commit [`a2ca25ab43eccc045bc7f2b86d3b579088da9af1`](https://github.com/personal-agent-protocol/personal-agent-protocol/blob/a2ca25ab43eccc045bc7f2b86d3b579088da9af1/content/versions/0.4/spec.mdx): section 3 (discovery), 4.1 (agent identity), 5.2–5.3 (the Session header and verifying it) and 7 (APIs and their errors).

| | |
|---|---|
| Code | [`lib/server/pap/`](../lib/server/pap) (the protocol: JWTs, keys, `verifySession`, discovery), [`lib/server/identity/agent.ts`](../lib/server/identity/agent.ts) (Front Desk's side: `identifyAgent`, the agents list, `poppy.json`) |
| Types | [`lib/types/agents.ts`](../lib/types/agents.ts): `BookingAgent`, `AgentSummary`, `AgentsResponse`, `PoppyDocument`, `PapErrorBody` |
| Routes | `GET /.well-known/poppy.json` (public), `POST /api/mcp` with `Poppy-Session`, `GET /api/shops/[shop]/agents` (owner) |
| Database | [`supabase/migrations/0009_agents.sql`](../supabase/migrations/0009_agents.sql): the `agents` table and `bookings.agent_client_id` |
| Demo agent | [`scripts/demo-pap-agent.mjs`](../scripts/demo-pap-agent.mjs) |
| Smoke | [`scripts/smoke-checks/agents.mjs`](../scripts/smoke-checks/agents.mjs), SMOKE.md items A1–A6 |

## How an agent is confirmed

1. **Discovery.** The agent reads `/.well-known/poppy.json`. It names the shop, Front Desk's host (`organization.domain`) and the MCP endpoint. Front Desk's Company identifier is `https://<organization.domain>` (spec 3.2), which on an HTTPS deployment is also the issuer connector sign-in uses ([connector-signin.md](connector-signin.md)). Each preview domain and the production domain is a separate Company.
2. **Every MCP request** carries:
   - `Poppy-Session`: a Session JWT (`typ: poppy-session+jwt`, ES256). The agent signs it with a short-lived **delegated key**. Its header holds the delegation (`poppy_dlg`), which a key at the agent's `jwks_uri` signed.
   - `Poppy-Version: 0.4`.
3. **`identifyAgent`** ([`lib/server/identity/agent.ts`](../lib/server/identity/agent.ts)) runs in [`app/api/mcp/route.ts`](../app/api/mcp/route.ts) before the MCP handler:
   - **No `Poppy-Session` header:** nothing changes. The request goes through as before, and `book` labels the booking with the MCP client's self-reported name (`agentNameFrom`), unconfirmed.
   - **The header verifies:** the agent is recorded in `agents` (client id, name, first and last seen). The tools run with its identity, and `book` stores `agent_client_id` and the verified name on the booking.
   - **The header doesn't verify:** the request gets PAP's error and no tool runs. That is HTTP 400 with `{"error": "invalid_session", "error_description": "<what to fix>"}`, or `version_unsupported` if `Poppy-Version` is missing or isn't 0.4. Per the spec, the agent fixes the cause, such as an expired delegation or a wrong `aud`, and starts a new Session.

### What `verifySession` checks

[`lib/server/pap/session.ts`](../lib/server/pap/session.ts), in this order:

- `Poppy-Version` is `0.4` (else `version_unsupported`).
- The Session JWT is `typ: poppy-session+jwt` and `alg: ES256`, with a `kid` and a `poppy_dlg`. It has `iss`, `aud`, `sid`, `sub` and `iat`.
- The delegation is `typ: poppy-delegation+jwt`, `alg` ES256 or PS384, with a `kid`, the same `iss`, `cnf.jwk`, `iat` and `exp`.
- **Audience:** `aud` is exactly `https://<host>` of the request (`companyIdentifier`).
- **Expiry:** the Session JWT's `iat` is no more than 60 seconds old, plus 30 seconds of clock skew either way. (PAP Session JWTs have no `exp`.) The delegation's `exp` hasn't passed, and is at most 24 hours after its `iat`.
- **Signatures:**
  1. The delegation verifies with the key named by its `kid` at the agent's `jwks_uri`.
  2. The Session JWT's `kid` is the RFC 7638 thumbprint of the delegation's `cnf.jwk`, and the Session JWT verifies with that key.

The agent's client metadata (fetched from `iss`, its `client_id`, without following redirects) and its key set are **cached for 10 minutes** per agent ([`lib/server/pap/client.ts`](../lib/server/pap/client.ts)). An unknown `kid` fetches them again at once, in case the agent rotated its key. For an HTTPS `client_id`, the metadata's own `client_id` must equal the URL. `client_name` becomes the agent's name: control characters are removed, it's trimmed, and it's cut to 80 characters.

Verification uses real time, never `FRONTDESK_NOW`: a frozen clock would expire every session.

### Not checked (MVP)

Signature and expiry checks identify the agent; nothing else is built. Each of these is listed under "Security not built" in the PR:

- `htm` and `htu` (the request's method and URL) aren't compared with the request.
- There's no replay table: a reused `jti` is accepted.
- Session continuity isn't kept: a `sid` isn't tied to its first `sub` or `agent_id`.
- `ath` isn't checked. A request can carry a connector access token and a `Poppy-Session`; each is verified on its own, and nothing ties one to the other.
- The URLs fetched get no address checks (loopback, private, link-local) and no size limit, only a 5-second timeout. The unknown-`kid` refetch isn't throttled, and `jwks_uri` isn't required to share the `client_id`'s domain.
- Any agent whose session verifies is accepted. There's no allowlist.

### `data:` client IDs (Front Desk's addition)

PAP 0.4 requires an HTTPS `client_id`, with an HTTPS `jwks_uri` on the same domain. A demo agent running on someone's laptop has no HTTPS host that a Vercel preview can reach. So Front Desk also accepts a `client_id` that is a `data:` URL of the client metadata (base64 or percent-encoded JSON), whose `jwks_uri` may be a `data:` URL of the JWK Set. That metadata can't contain its own URL, so its `client_id` field isn't checked.

A `data:` agent is confirmed in the sense that the same key signed its session. Its name isn't backed by a domain: anyone can make a `data:` agent with any name. An HTTPS agent's name is vouched for by the domain serving its metadata. The console can tell the two apart by the `clientId`'s scheme.

## What changes for bookings

`Booking.agent` is now `BookingAgent`:

```json
{ "name": "Front Desk demo agent", "confirmed": true, "clientId": "https://agent.example/agent.json" }
{ "name": "claude-ai", "confirmed": false }
```

- `confirmed: true` only when `book` ran in a request whose `Poppy-Session` verified. `name` is then the agent's `client_name`, never the name the MCP client reports.
- `confirmed: false` everywhere else: MCP without PAP (the client's self-reported name, or `"unknown agent"`), the web booking API (`bookedBy`, or `"web (<User-Agent>)"`) and the booking page.
- The `booked` event's data gains `agentClientId` for a confirmed booking.
- The MCP tools' output schema has the same three fields.

## `GET /api/shops/[shop]/agents` → `AgentsResponse`

Owner route: `Authorization: Bearer <OWNER_API_TOKEN>` or the `fd_owner` cookie. Without them it's a 401 that says to open `/console/unlock`. An unknown shop is a 404.

```json
{
  "shop": { "slug": "harts", "name": "Hart's Barbers", "timezone": "America/New_York" },
  "agents": [
    {
      "clientId": "https://agent.example/agent.json",
      "name": "Example Agent",
      "firstSeen": "2026-11-08T09:12:03.512-05:00",
      "lastSeen": "2026-11-09T14:40:11.004-05:00",
      "bookings": 3,
      "lastBookedAt": "2026-11-09T14:40:11.38-05:00"
    }
  ],
  "unconfirmedBookings": 41
}
```

- `agents`: every PAP agent Front Desk has seen, most recently seen first. An agent that only looked (`list_services`, say) is listed with `bookings: 0` and `lastBookedAt: null`.
- `bookings`: its bookings at this shop, of any status. Holds that lapsed or were declined count too.
- `firstSeen` and `lastSeen` are its first and latest verified requests, anywhere on Front Desk. `TODO(ring-2)`: agents aren't scoped to a shop yet, since Front Desk serves one.
- `unconfirmedBookings`: the shop's bookings with no confirmed agent.

## `GET /.well-known/poppy.json` → `PoppyDocument`

Public. It's built from the request's origin and needs no setting. If the shop can't be read, it still answers, named "Front Desk".

```json
{
  "protocol_version": "0.4",
  "organization": { "name": "Hart's Barbers", "domain": "emergent.vercel.app" },
  "apis": [
    {
      "type": "mcp",
      "url": "https://emergent.vercel.app/api/mcp",
      "description": "Book appointments at Hart's Barbers: services, booking rules, open times, book, check and cancel. Send the Poppy-Session header so the shop sees who booked; every booking still needs the person's approval."
    }
  ]
}
```

There's no `auth` (connector sign-in isn't advertised to PAP agents), no `agent` (no Company Agent) and no `web` section. `/.well-known/front-desk.json` links to it as `poppy`. Locally, `domain` includes the port (`localhost:3000`), and agents use `https://localhost:3000` as `aud` there too.

## The demo PAP agent

```bash
node scripts/demo-pap-agent.mjs <base-url> [--bypass <secret>] [--name <agent name>] [--customer <name>] [--new-key]
```

It books a Beard trim and prints the approval link and how the shop sees the agent:

```
Agent: Front Desk demo agent (key 3vJ0r4p9cQ2s…, kept in /var/folders/…/front-desk-demo-pap-agent.json)
MCP: https://<preview>/api/mcp
Booked Beard trim, Sat 14 Nov, 10:00 am EST, for Demo Customer: awaiting_approval.
The shop sees the agent as: Front Desk demo agent (confirmed).
Approve or decline it here: https://<preview>/approve/…
Booking id: …
```

- It keeps its identity key in the OS temp directory, so every run is the same agent and its count in the agents list goes up. `--new-key` makes a new agent.
- Its `client_id` and `jwks_uri` are `data:` URLs (see above), so it works against `pnpm dev`, a preview or production without hosting anything.
- Previews are behind Vercel Authentication: pass `--bypass` or set `VERCEL_AUTOMATION_BYPASS_SECRET`, as for `pnpm smoke`.
- It makes a real booking. Never run it against production. Decline the booking from its link, or let the hold lapse in 10 minutes.

`pnpm smoke` runs it as `front-desk-smoke (PAP)` with a new key each run (items A3–A5), and declines what it books.

## Tests

| File | What it covers |
|---|---|
| [`lib/server/pap/session.test.ts`](../lib/server/pap/session.test.ts) | `verifySession` against sessions the demo agent signs. Valid sessions are accepted. These are refused: an expired delegation, a stale `iat`, the wrong `aud`, a missing or old `Poppy-Version`, no delegation, a forged delegation or Session JWT, and a wrong `kid`. Also: the 10-minute key cache, the refetch on an unknown `kid`, the HTTPS `client_id` rule, `poppy.json` and RFC 7638 thumbprints. |
| [`lib/server/identity/agent.test.ts`](../lib/server/identity/agent.test.ts) | End to end through the MCP handler, wired as the route wires it. A PAP agent's booking is confirmed and recorded. Last seen updates. An expired or wrong-audience session gets `invalid_session` and books nothing. A request without the header is unconfirmed, as before. The agents list counts per agent and unconfirmed. The owner 401 and 404. `poppy.json`. |
| [`lib/server/frontdesk/postgres-store.test.ts`](../lib/server/frontdesk/postgres-store.test.ts) | On Postgres: `recordAgent` (first and last seen, renames), `agent_client_id` on bookings and in the `booked` event, `listAgents` counts and order. |
| [`scripts/smoke-checks/agents.test.mjs`](../scripts/smoke-checks/agents.test.mjs) | Smoke's agent checks (A1–A6) pass against a fake deployment, fail when a PAP booking comes back unconfirmed, are skipped where writes aren't allowed, and decline what they book. |
