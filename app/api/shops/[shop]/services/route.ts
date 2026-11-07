import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { servicesPost, servicesResponse } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/services — the shop and what it sells (ServicesResponse in lib/types/frontdesk.ts).
// Unknown shop → 404 with the ApiError envelope.
export async function GET(_request: Request, ctx: RouteContext<"/api/shops/[shop]/services">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return servicesResponse(getFrontDeskDeps, shop);
}

// POST /api/shops/[shop]/services — add a service (CreateServiceRequest → 201 ServiceResponse).
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>. TODO(ring-2): owner sign-in replaces the token.
// (GET above stays public.)
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[shop]/services">) {
  await connection();
  const { shop } = await ctx.params;
  return servicesPost(getFrontDeskDeps, request, shop);
}
