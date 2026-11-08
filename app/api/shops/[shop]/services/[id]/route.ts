import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { servicePatch } from "@/lib/server/frontdesk/http";

// PATCH /api/shops/[shop]/services/[id] — change a service's name, duration, price or deposit
// (UpdateServiceRequest → ServiceResponse in lib/types/frontdesk.ts). Errors use the ApiError envelope.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie. TODO(ring-2): owner sign-in replaces the token.
export async function PATCH(request: Request, ctx: RouteContext<"/api/shops/[shop]/services/[id]">) {
  // Writes the database: request-time only, never prerendered.
  await connection();
  const { shop, id } = await ctx.params;
  return servicePatch(getFrontDeskDeps, request, shop, id);
}
