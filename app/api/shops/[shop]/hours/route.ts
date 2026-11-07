import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { hoursGet, hoursPut } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/hours — every staff member's regular week (HoursResponse).
// PUT /api/shops/[shop]/hours — replace one staff member's whole week (UpdateHoursRequest → HoursResponse).
// Types in lib/types/frontdesk.ts. Errors use the ApiError envelope.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>. TODO(ring-2): owner sign-in replaces the token.

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/hours">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return hoursGet(getFrontDeskDeps, request, shop);
}

export async function PUT(request: Request, ctx: RouteContext<"/api/shops/[shop]/hours">) {
  await connection();
  const { shop } = await ctx.params;
  return hoursPut(getFrontDeskDeps, request, shop);
}
