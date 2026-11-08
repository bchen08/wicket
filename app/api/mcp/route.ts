import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { createFrontDeskMcpHandler } from "@/lib/server/frontdesk/mcp";
import { withRequestOrigin } from "@/lib/server/frontdesk/service";
import { withCustomerSignin } from "@/lib/server/identity/customer";

// /api/mcp — Front Desk's MCP server (Streamable HTTP, stateless).
// Tools: list_services, get_policies, get_availability, book, get_booking, cancel, list_my_bookings.
// See docs/frontdesk-api.md.

// Connector sign-in (docs/connector-signin.md): withCustomerSignin checks a bearer token when there is one, so
// a signed-in agent books as its person; anonymous calls are served as before. A booking only becomes final
// when the person approves it through the link book returns (Ring 1b), and get_booking and cancel still trust
// anyone holding the booking id (TODO(ring-2) in service.ts).

// Answers depend on the clock and the database, so this must never be prerendered or cached.
// Under cacheComponents, connection() makes the handler request-time only.
async function handler(request: Request): Promise<Response> {
  await connection();
  // A handler per request, so approval links use this request's origin (previews and production alike,
  // with no setting). Deps are resolved on each tool call (Postgres, or in-memory locally; see deps.ts),
  // so a configuration error becomes a tool error instead of a crash.
  const mcpHandler = createFrontDeskMcpHandler(() => withRequestOrigin(getFrontDeskDeps(), request));
  return mcpHandler(request);
}

const gated = withCustomerSignin(handler);

export { gated as GET, gated as POST };
