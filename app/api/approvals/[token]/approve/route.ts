import { connection } from "next/server";
import { approvalApprovePost } from "@/lib/server/consent/http";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";

// POST /api/approvals/[token]/approve — approve (ApproveRequest, optional: { phone? } → ApproveResponse):
// the booking becomes confirmed. Also takes a plain HTML form post (optional `phone` field) and answers
// 303 → /approve/<token>. Public: the token in the path is the credential, and opening the link and
// approving is the consent. TODO(ring-1c): a texted code comes back with real texting.
export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[token]/approve">) {
  // Reads the clock and writes the database: request-time only, never prerendered.
  await connection();
  const { token } = await ctx.params;
  return approvalApprovePost(getFrontDeskDeps, request, token);
}
