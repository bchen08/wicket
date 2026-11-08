import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { policiesGet, policiesPut } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/policies — the shop's booking rules (PoliciesResponse).
// PUT /api/shops/[shop]/policies — change some of them (UpdatePoliciesRequest → PoliciesResponse).
// Types in lib/types/frontdesk.ts. Errors use the ApiError envelope.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie. TODO(ring-2): owner sign-in replaces the token.

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/policies">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return policiesGet(getFrontDeskDeps, request, shop);
}

export async function PUT(request: Request, ctx: RouteContext<"/api/shops/[shop]/policies">) {
  await connection();
  const { shop } = await ctx.params;
  return policiesPut(getFrontDeskDeps, request, shop);
}
