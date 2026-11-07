import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { bookingDetailGet } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/bookings/[id] — one booking and its history, oldest event first
// (BookingDetailResponse in lib/types/frontdesk.ts). Unknown id → 404 booking_not_found.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>. TODO(ring-2): owner sign-in replaces the token.
export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/bookings/[id]">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop, id } = await ctx.params;
  return bookingDetailGet(getFrontDeskDeps, request, shop, id);
}
