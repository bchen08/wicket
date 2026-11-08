import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { bookingActionPost } from "@/lib/server/frontdesk/http";

// POST /api/shops/[shop]/bookings/[id]/complete — Mark a booking completed, after its start (deposit released).
// Uses decide() with actor "owner" (OwnerBookingActionResponse in lib/types/frontdesk.ts). No body.
// A state that doesn't allow it → 400 invalid_request; unknown id → 404 booking_not_found.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie. TODO(ring-2): owner sign-in replaces the token.
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[shop]/bookings/[id]/complete">) {
  // Reads the clock and writes the database: request-time only, never prerendered.
  await connection();
  const { shop, id } = await ctx.params;
  return bookingActionPost(getFrontDeskDeps, request, shop, id, "complete");
}
