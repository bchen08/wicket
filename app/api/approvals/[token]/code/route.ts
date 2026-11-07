import { connection } from "next/server";
import { approvalCodePost } from "@/lib/server/consent/http";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";

// POST /api/approvals/[token]/code — text the person a 6-digit code (SendCodeRequest → SendCodeResponse).
// Public: the token in the path is the credential. The Origin header must equal PUBLIC_BASE_URL's
// origin, or 403 invalid_request. Limits: 3 codes per phone per hour, 10 per link per hour (429 rate_limited).
export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[token]/code">) {
  // Reads the clock and writes the database: request-time only, never prerendered.
  await connection();
  const { token } = await ctx.params;
  return approvalCodePost(getFrontDeskDeps, request, token);
}
