# Front Desk

**A booking desk that AI agents can talk to.**

Front Desk gives a small business a front desk that AI agents can use: Claude, ChatGPT, or someone's personal assistant. An agent connects over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), or over plain HTTP. It can ask the business what it offers, what its rules are, and when it's free, then book or cancel an appointment. **No booking is final until a real person approves it.**

The demo shop is **Hart's Barbers** (`harts`), a barbershop in New York.

**Live:** https://emergent-blush-iota.vercel.app · **Agent endpoint:** `https://emergent-blush-iota.vercel.app/api/mcp` · **Booking page:** https://emergent-blush-iota.vercel.app/harts

## How it works

```
AI agent ──MCP──▶ /api/mcp ─────────────┐
Agent or browser ──▶ /api/shops/harts ──┤
Person ──▶ /signin, /approve/<link> ────┼──▶ Front Desk engine ──▶ Postgres (Supabase)
Owner ──▶ /console ─────────────────────┘    (hours, rules, lifecycle)
                                                 │
                                    Stripe (deposits) · Resend (email) · Photon or Twilio (texts)
```

1. **The agent asks.** Seven MCP tools: `list_services`, `get_policies`, `get_availability`, `book`, `get_booking`, `cancel` and `list_my_bookings`. Agents without MCP use the [web booking API](docs/web-booking.md), and find both through `/.well-known/front-desk.json` and the shop's `agents.md`.
2. **The agent books, and the slot is held.** `book` holds the time for 10 minutes and returns an approval link. Given the person's mobile number, Front Desk can text them the link.
3. **A person approves.** They open the link on their phone and tap **Approve** or **Decline**. If the service takes a deposit, Approve leads to Stripe Checkout and the booking is confirmed once the card hold succeeds. If nobody answers in time, the hold lapses and the slot opens up again.
4. **The owner sees it.** At `/console`, the owner sees every booking and every agent that booked, and gets an alert (email, text or log line) when a booking is confirmed or cancelled.
5. **Every night, it tidies up.** Past appointments are marked completed (and their deposit hold released), and lapsed holds and unpaid deposits are closed.

**People can sign in once.** Connected to Claude or ChatGPT, Front Desk asks the person to sign in at `/signin` with their name and mobile number. Their agent then books as them, without retyping the name, and can list and cancel their bookings. Agents that don't sign in keep working as before. See [connector-signin.md](docs/connector-signin.md).

**Agents can prove who they are.** An agent that speaks [PAP 0.4](https://github.com/personal-agent-protocol/personal-agent-protocol) signs its requests, and its bookings show it as **confirmed**. Everyone else is labelled unconfirmed. See [agent-identity.md](docs/agent-identity.md).

**The shop's rules apply everywhere.** Opening hours, lunch breaks, blocked time, a minimum lead time, a booking horizon, a cancellation window and deposits all come from the shop's policies. Availability and booking both read them, so an agent can't book a slot the shop wouldn't offer. The database refuses overlapping bookings.

**Errors tell the agent what to do next.** Every error has a code (`slot_taken`, `too_soon`, `outside_hours`, …) and a `next_action`. `slot_taken` also suggests up to 3 nearby free times.

**The owner API** (protected by the shop's access code) can pause bookings, change hours, block time, edit services and rules, cancel a booking, and mark one completed or a no-show.

| Feature | Docs |
|---|---|
| MCP tools, owner API, consent flow | [frontdesk-api.md](docs/frontdesk-api.md) |
| Web booking API and booking page | [web-booking.md](docs/web-booking.md) |
| Deposits (Stripe, test mode) | [deposits.md](docs/deposits.md) |
| Texting (Photon iMessage or Twilio SMS) | [texting.md](docs/texting.md) |
| Connector sign-in (OAuth for Claude and ChatGPT) | [connector-signin.md](docs/connector-signin.md) |
| Agent identity (PAP 0.4) | [agent-identity.md](docs/agent-identity.md) |
| Nightly tidy-up | [nightly.md](docs/nightly.md) |
| Database, migrations, Preview database | [database.md](docs/database.md) |

## Try it with an agent

In Claude: **Customize → Connectors → Add custom connector**, with the URL:

```
https://emergent-blush-iota.vercel.app/api/mcp
```

Then ask something like *"What haircut times does Hart's Barbers have this Saturday?"*, then *"Book me the 2:30."* Claude shows a sign-in step the first time it needs you. Sign in with your name and mobile number, open the approval link Claude gives you, and tap Approve. Later, *"What appointments do I have at Hart's?"* lists your bookings.

In ChatGPT (developer mode), create a connector with the same URL and Authentication set to **OAuth**.

This is the live shop: a booking you approve is a real booking. Cancel it when you're done.

## Run it locally

You need Node.js and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. The MCP endpoint is http://localhost:3000/api/mcp.

**No database needed to start.** Without `DATABASE_URL`, Front Desk uses an in-memory copy of the seed data and logs one warning. Bookings disappear when the server restarts. To use a real Postgres database, or to open the owner console, put these in `.env.local`, which git ignores:

```bash
DATABASE_URL=postgres://...      # Supabase transaction pooler, port 6543
OWNER_API_TOKEN=...              # the shop's access code for /console/unlock and the owner API
```

**Every other feature is off until you set its variables**, and Front Desk works without them. `/api/status` shows which are on.

| Variable | Turns on |
|---|---|
| `STRIPE_SECRET_KEY` (a `sk_test_…` key only) | Deposits through Stripe Checkout |
| `RESEND_API_KEY` | Owner alerts by email (otherwise a log line) |
| `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_LINE`, or `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Texting: approval links, owner alerts and the owner's sign-in code |

Never commit any of them. On Vercel they're environment variables.

[`docs/database.md`](docs/database.md) covers setup, migrations and the seed.

**Checks** (CI runs the first four on every push):

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm smoke <URL>` runs the [SMOKE.md](SMOKE.md) checks against a running deployment, for example `pnpm smoke http://localhost:3000`. Every PR is also checked by a separate verifier session; see [docs/VERIFIER.md](docs/VERIFIER.md).

## What's next

Front Desk is built in rings, each one a working product. Rings 0, 1 and 2 are live: agents book with a person's approval, deposits, owner alerts, texting, connector sign-in, agent identity, the nightly tidy-up and the owner console. Still to come:

- Verify the phone number at sign-in with a texted code.
- Let agents choose which shop to book, and give each shop its own owner sign-in instead of one shared access code.
- Retry failed owner alerts, and send alert email from the shop's own domain.

Each one is marked `TODO(ring-N)` in the code.

## Built with

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · MCP · Supabase Postgres · Stripe · Resend · Photon / Twilio · Vercel

## Contributing

[`AGENTS.md`](AGENTS.md) has the rules every contributor follows, human or agent. [`docs/WORKFLOW.md`](docs/WORKFLOW.md) describes how a change goes from issue to production.
