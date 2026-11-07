import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { bookingsResponse } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/bookings — bookings of any status from 7 days ago to 30 days ahead,
// sorted by start (BookingsResponse in lib/types/frontdesk.ts). Public: no owner token.
// Unknown shop → 404 with the ApiError envelope.
// No sign-in yet: see TODO(ring-2) on listShopBookings in lib/server/frontdesk/service.ts.
export async function GET(_request: Request, ctx: RouteContext<"/api/shops/[shop]/bookings">) {
  // Reads the database and the clock: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return bookingsResponse(getFrontDeskDeps, shop);
}
