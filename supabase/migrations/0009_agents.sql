-- Front Desk: agent identity (PAP 0.4). Apply once per database, after the migrations before it.
-- Seeds nothing. See docs/agent-identity.md and docs/database.md.
-- TODO: renumber before review, after the migrations ahead of it in other PRs land.
--
-- Agents that speak PAP 0.4 send a signed Poppy-Session header with their MCP requests. When it verifies,
-- Front Desk records the agent here and stores its client_id on the bookings it makes, so the console can
-- show a confirmed agent and list the agents seen. Agents without PAP keep booking as before: their
-- bookings have agent_client_id null and show as unconfirmed.
-- Additive only: one new table and one nullable column.

create table agents (
  -- The agent's PAP client_id: an HTTPS URL, or a data: URL for a demo agent that hosts nothing.
  client_id   text        primary key,
  -- client_name from its client metadata, as of its latest verified request.
  name        text        not null,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

alter table agents enable row level security;

-- The confirmed agent that made the booking, or null (unconfirmed). No foreign key: a booking keeps its
-- agent even if recording the agent failed, and the agents list simply doesn't count it.
alter table bookings add column agent_client_id text;

create index bookings_agent_client_id on bookings (agent_client_id) where agent_client_id is not null;
