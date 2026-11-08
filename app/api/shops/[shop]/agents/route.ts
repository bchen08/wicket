import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { agentsGet } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/agents — the PAP agents Front Desk has seen, most recently seen first, with their
// bookings at this shop and when they were last seen; plus how many bookings came from unconfirmed agents
// (AgentsResponse in lib/types/agents.ts). See docs/agent-identity.md.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie that /console/unlock sets.
// 401 says to open /console/unlock. Unknown shop → 404. TODO(ring-2): owner sign-in replaces the token.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/agents">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return agentsGet(getFrontDeskDeps, request, shop);
}
