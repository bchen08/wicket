import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { agentsMdGet } from "@/lib/server/frontdesk/web-http";

// GET /api/shops/[shop]/agents.md — plain-text instructions for AI agents: how to book at this shop (MCP
// first, then the web API), the approval link, the errors and the shop's rules. Public. See docs/web-booking.md.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/agents.md">) {
  // Reads the clock and the database (services, rules): request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return agentsMdGet(getFrontDeskDeps, request, shop);
}
