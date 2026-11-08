import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { availabilityGet } from "@/lib/server/frontdesk/web-http";

// GET /api/shops/[shop]/availability?service=<id>&from=<YYYY-MM-DD>&days=<1..14> — open starts for one
// service, day by day in the shop's time zone (WebAvailabilityResponse in lib/types/web-booking.ts). The
// same slots as the MCP get_availability tool. Public. See docs/web-booking.md.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/availability">) {
  // Reads the clock and the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return availabilityGet(getFrontDeskDeps, request, shop);
}
