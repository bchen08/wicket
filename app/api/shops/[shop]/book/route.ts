import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { bookPost } from "@/lib/server/frontdesk/web-http";

// POST /api/shops/[shop]/book — hold a start until the person approves it, like the MCP book tool.
// JSON (WebBookRequest) → 201 WebBookResponse with booking.approval.url. A plain HTML form post (service,
// start, name, bookedBy) → 303 to /approve/<token>, or back to the Referer with ?error=<code>&message=<text>.
// Public, like MCP book (TODO(ring-2): agent sign-in). See docs/web-booking.md.
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[shop]/book">) {
  // Reads the clock and writes the database: request-time only, never prerendered.
  await connection();
  const { shop } = await ctx.params;
  return bookPost(getFrontDeskDeps, request, shop);
}
