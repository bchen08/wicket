import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { bookingPageGet } from "@/lib/server/frontdesk/web-http";

// GET /api/shops/[shop]/booking-page — everything the web booking page needs in one call: the shop, its
// rules (and in plain words), and every service with the next 7 days of open starts (BookingPageResponse
// in lib/types/web-booking.ts). Public. See docs/web-booking.md.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/booking-page">) {
  // Reads the clock and the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return bookingPageGet(getFrontDeskDeps, request, shop);
}
