import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { servicesResponse } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/services — the shop and what it sells (ServicesResponse in lib/types/frontdesk.ts).
// Unknown shop → 404 with the ApiError envelope.
export async function GET(_request: Request, ctx: RouteContext<"/api/shops/[shop]/services">) {
  // Reads the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return servicesResponse(getFrontDeskDeps, shop);
}
