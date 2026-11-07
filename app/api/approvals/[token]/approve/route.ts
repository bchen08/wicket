import { connection } from "next/server";
import { approvalApprovePost } from "@/lib/server/consent/http";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";

// POST /api/approvals/[token]/approve — approve with the code (ApproveRequest → ApproveResponse): the
// booking becomes confirmed with a verified customer. Public: the token in the path is the credential.
// The Origin header must equal PUBLIC_BASE_URL's origin, or 403 invalid_request.
export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[token]/approve">) {
  // Reads the clock and writes the database: request-time only, never prerendered.
  await connection();
  const { token } = await ctx.params;
  return approvalApprovePost(getFrontDeskDeps, request, token);
}
