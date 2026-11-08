import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { bookingsResponse } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/bookings — bookings of any status from 7 days ago to 30 days ahead,
// sorted by start (BookingsResponse in lib/types/frontdesk.ts). Bookings awaiting approval include
// their approval link.
// Owner route (it shows customers' phone numbers): Authorization: Bearer <OWNER_API_TOKEN>, or the
// fd_owner cookie that /console/unlock sets. 401 says to open /console/unlock.
// Unknown shop → 404 with the ApiError envelope. TODO(ring-2): owner sign-in replaces the token.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/bookings">) {
  // Reads the database and the clock: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return bookingsResponse(getFrontDeskDeps, request, shop);
}
