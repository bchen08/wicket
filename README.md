# Front Desk

**A booking desk that AI agents can talk to.**

Front Desk gives a small business a front desk that AI agents can use: Claude, ChatGPT, or someone's personal assistant. An agent connects over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). It can ask the business what it offers, what its rules are, and when it's free, then book or cancel an appointment. **No booking is final until a real person approves it.**

The demo shop is **Hart's Barbers** (`harts`), a barbershop in New York.

**Live:** https://emergent-blush-iota.vercel.app · **Agent endpoint:** `https://emergent-blush-iota.vercel.app/api/mcp`

## How it works

```
AI agent ──MCP──▶ /api/mcp ───────┐
Person ──▶ /approve/<link> ───────┼──▶ Front Desk engine ──▶ Postgres (Supabase)
Owner ───▶ /console ──────────────┘    (hours, rules, lifecycle)
```

1. **The agent asks.** Six MCP tools: `list_services`, `get_policies`, `get_availability`, `get_booking`, `book` and `cancel`.
2. **The agent books, and the slot is held.** `book` holds the time for 10 minutes and returns an approval link.
3. **A person approves.** The agent hands the person the link. They open it on their phone and tap **Approve** (the booking becomes `confirmed`) or **Decline**. If nobody answers in 10 minutes, the hold lapses and the slot opens up again.
4. **The owner sees it.** At `/console` (unlocked with the shop's access code), the owner sees every booking, including ones still waiting for approval.

**The shop's rules apply everywhere.** Opening hours, lunch breaks, blocked time, a minimum lead time, a booking horizon and a cancellation window all come from the shop's policies. Availability and booking both read them, so an agent can't book a slot the shop wouldn't offer. The database refuses overlapping bookings.

**Errors tell the agent what to do next.** Every error has a code (`slot_taken`, `too_soon`, `outside_hours`, …) and a `next_action`. `slot_taken` also suggests up to 3 nearby free times.

**The owner API** (token-protected) can pause bookings, change hours, block time, edit services, and mark a booking completed or a no-show.

Full reference: [`docs/frontdesk-api.md`](docs/frontdesk-api.md).

## Try it with an agent

In Claude: **Settings → Connectors → Add custom connector**, with the URL:

```
https://emergent-blush-iota.vercel.app/api/mcp
```

Leave the OAuth fields empty. Then ask something like *"What haircut times does Hart's Barbers have this Saturday?"*, then *"Book the 2:30 for Maya."* Open the approval link Claude gives you and tap Approve.

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

[`docs/database.md`](docs/database.md) covers setup, migrations and the seed.

**Checks** (CI runs these on every push):

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## What's next

Front Desk is built in rings, each one a working product. Rings 0 and 1 are live: agents can see availability, book, and get a person's approval, and the owner has a console. Coming next:

- **Ring 1c:** collect deposits (Stripe), text the person a code instead of relying on the link alone, and alert the owner on a real channel.
- **Ring 2:** sign-in for agents and for owners, agents choosing which shop to book, and a background job that expires lapsed holds.

The full list is in [Not built yet](docs/frontdesk-api.md#not-built-yet).

## Built with

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · MCP · Supabase Postgres · Vercel

## Contributing

[`docs/WORKFLOW.md`](docs/WORKFLOW.md) describes how a change goes from issue to production.
