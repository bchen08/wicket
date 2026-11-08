import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { blocksDelete, blocksGet, blocksPost } from "@/lib/server/frontdesk/http";

// GET /api/shops/[shop]/blocks?from=&to= — blocked times (holidays, time off) in a range (BlocksResponse).
// POST /api/shops/[shop]/blocks — add one (CreateBlockRequest → 201 BlockResponse).
// DELETE /api/shops/[shop]/blocks?id=<uuid> — remove one (→ BlockResponse, the deleted block).
// Types in lib/types/frontdesk.ts. Errors use the ApiError envelope.
// Owner route: Authorization: Bearer <OWNER_API_TOKEN>, or the fd_owner cookie. TODO(ring-2): owner sign-in replaces the token.

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[shop]/blocks">) {
  // Reads the database and the clock: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return blocksGet(getFrontDeskDeps, request, shop);
}

export async function POST(request: Request, ctx: RouteContext<"/api/shops/[shop]/blocks">) {
  await connection();
  const { shop } = await ctx.params;
  return blocksPost(getFrontDeskDeps, request, shop);
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/shops/[shop]/blocks">) {
  await connection();
  const { shop } = await ctx.params;
  return blocksDelete(getFrontDeskDeps, request, shop);
}
