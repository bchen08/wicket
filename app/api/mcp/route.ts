import { connection } from "next/server";
import { systemClock } from "@/lib/server/clock";
import { createHardcodedCatalog } from "@/lib/server/frontdesk/hardcoded-catalog";
import { createFrontDeskMcpHandler } from "@/lib/server/frontdesk/mcp";

// /api/mcp — Front Desk's MCP server (Streamable HTTP, stateless).
// Tools: list_services, get_availability. See docs/frontdesk-api.md.

// TODO(ring-0): swap the hard-coded catalog for the Postgres one in the next slice.
// TODO(ring-2): sign-in. Authenticate callers (mcp-handler's withMcpAuth) before booking ships.
const mcpHandler = createFrontDeskMcpHandler({
  clock: systemClock,
  catalog: createHardcodedCatalog(systemClock),
});

// Answers depend on the clock, so this must never be prerendered or cached.
// Under cacheComponents, connection() makes the handler request-time only.
async function handler(request: Request): Promise<Response> {
  await connection();
  return mcpHandler(request);
}

export { handler as GET, handler as POST };
