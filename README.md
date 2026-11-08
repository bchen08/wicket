# Front Desk

**A booking desk that AI agents can talk to.**

Front Desk gives a small business a front desk that AI agents can use: Claude, ChatGPT, or someone's personal assistant. An agent connects over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). It can ask the business what it offers, what its rules are, and when it's free, then book or cancel an appointment. The owner sets the rules, and every booking follows them.

The demo shop is **Hart's Barbers** (`harts`), a barbershop in New York.

**Live:** https://emergent-blush-iota.vercel.app · **Agent endpoint:** `https://emergent-blush-iota.vercel.app/api/mcp`

## How it works

```
AI agent ──MCP──▶ /api/mcp ──┐
                             ├──▶ Front Desk engine ──▶ Postgres (Supabase)
Owner console ─▶ /api/shops ─┘    (hours, rules, lifecycle)
```

- **Agents** use six MCP tools: `list_services`, `get_policies`, `get_availability`, `get_booking`, `book` and `cancel`.
- **The rules live in one place.** Opening hours, lunch breaks, blocked time, a minimum lead time, a booking horizon and a cancellation window all come from the shop's policies. Availability and booking both read them, so an agent can't book a slot the shop wouldn't offer.
- **Bookings are safe to retry.** `book` and `cancel` take an `idempotency_key`, so an agent that retries after a timeout gets the same booking back, not a second one. The database also refuses overlapping bookings.
- **Errors tell the agent what to do next.** Every error has a code (`slot_taken`, `too_soon`, `outside_hours`, …) and a `next_action`. `slot_taken` also suggests nearby free times.
- **The owner** can see bookings in the console (`/console`). Owner routes, protected by a token for now, let the owner pause bookings, change hours, block time, edit services, and mark a booking completed or a no-show.

Full reference: [`docs/frontdesk-api.md`](docs/frontdesk-api.md).

## Try it with an agent

Add Front Desk as a remote MCP server in any client that supports Streamable HTTP:

```
https://emergent-blush-iota.vercel.app/api/mcp
```

Then ask something like *"Book me a haircut at Hart's Barbers next Tuesday morning."*

## Run it locally

You need Node.js and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. The MCP endpoint is http://localhost:3000/api/mcp.

**No database needed to start.** Without `DATABASE_URL`, Front Desk uses an in-memory copy of the seed data and logs one warning. Bookings disappear when the server restarts. To use a real Postgres database, put these in `.env.local`, which git ignores:

```bash
DATABASE_URL=postgres://...      # Supabase transaction pooler, port 6543
OWNER_API_TOKEN=...              # 16+ random characters; needed for owner routes
```

[`docs/database.md`](docs/database.md) covers setup, migrations and the seed.

**Checks** (CI runs these on every push):

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Built with

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · MCP · Supabase Postgres · Vercel

## Contributing

[`docs/WORKFLOW.md`](docs/WORKFLOW.md) describes how a change goes from issue to production.
