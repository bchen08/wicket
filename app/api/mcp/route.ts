import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { createFrontDeskMcpHandler } from "@/lib/server/frontdesk/mcp";
import { withRequestOrigin } from "@/lib/server/frontdesk/service";
import { identifyAgent } from "@/lib/server/identity/agent";

// /api/mcp — Front Desk's MCP server (Streamable HTTP, stateless).
// Tools: list_services, get_policies, get_availability, book, get_booking, cancel. See docs/frontdesk-api.md.

// TODO(ring-2): sign-in. Authenticate callers (mcp-handler's withMcpAuth); book and cancel are open to anyone today.
// A booking only becomes final when the person approves it through the link book returns (Ring 1b), but
// get_booking and cancel still trust anyone holding the booking id (TODO(ring-2) in service.ts).

// Answers depend on the clock and the database, so this must never be prerendered or cached.
// Under cacheComponents, connection() makes the handler request-time only.
async function handler(request: Request): Promise<Response> {
  await connection();
  // PAP agents (a Poppy-Session header) are confirmed here, or refused with PAP's error; without the header
  // nothing changes. See lib/server/identity/agent.ts and docs/agent-identity.md.
  const agent = await identifyAgent(request, getFrontDeskDeps);
  if (agent instanceof Response) return agent;
  // A handler per request, so approval links use this request's origin (previews and production alike,
  // with no setting). Deps are resolved on each tool call (Postgres, or in-memory locally; see deps.ts),
  // so a configuration error becomes a tool error instead of a crash.
  const mcpHandler = createFrontDeskMcpHandler(() => withRequestOrigin(getFrontDeskDeps(), request), agent);
  return mcpHandler(request);
}

export { handler as GET, handler as POST };
