import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { createFrontDeskMcpHandler } from "@/lib/server/frontdesk/mcp";

// /api/mcp — Front Desk's MCP server (Streamable HTTP, stateless).
// Tools: list_services, get_policies, get_availability, book, get_booking, cancel. See docs/frontdesk-api.md.

// TODO(ring-2): sign-in. Authenticate callers (mcp-handler's withMcpAuth); book and cancel are open to anyone today.
// TODO(ring-1b): customer consent. Until then anyone holding a booking id can read or cancel it (see service.ts).
// Deps are resolved on each tool call (Postgres, or in-memory locally; see lib/server/frontdesk/deps.ts).
const mcpHandler = createFrontDeskMcpHandler(getFrontDeskDeps);

// Answers depend on the clock and the database, so this must never be prerendered or cached.
// Under cacheComponents, connection() makes the handler request-time only.
async function handler(request: Request): Promise<Response> {
  await connection();
  return mcpHandler(request);
}

export { handler as GET, handler as POST };
