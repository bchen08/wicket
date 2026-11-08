import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { alertsGet } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/alerts — the shop's newest 50 owner alerts, newest first (AlertsResponse in
// lib/types/frontdesk.ts): every booking confirmed or cancelled, how the owner was told (email or log) and
// whether it worked.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie that /console/unlock sets.
// 401 says to open /console/unlock. Unknown shop → 404. TODO(ring-2): owner sign-in replaces the token.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/alerts">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return alertsGet(getFrontDeskDeps, request, shop);
}
