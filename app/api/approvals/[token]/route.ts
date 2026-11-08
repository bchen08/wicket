import { connection } from "next/server";
import { approvalGet } from "@/lib/server/consent/http";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";

// GET /api/approvals/[token] — what the approval page shows: the booking, the shop's rules, the
// mandate and where the request stands (ApprovalView in lib/types/frontdesk.ts).
// Public: the token in the path is the credential. Unknown token → 404 booking_not_found.
// Expires the hold first if it lapsed (lazy expiry). See docs/frontdesk-api.md, "Consent flow".
export async function GET(_request: Request, ctx: RouteContext<"/api/approvals/[token]">) {
  // Reads the clock and the database: request-time only, never prerendered.
  await connection();
  const { token } = await ctx.params;
  return approvalGet(getFrontDeskDeps, token);
}
