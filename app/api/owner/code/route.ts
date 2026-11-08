import { connection } from "next/server";
import { ownerCodePost } from "@/lib/server/frontdesk/owner-code";

// POST /api/owner/code — text a 6-digit sign-in code to the shop's ownerMobile (valid 10 minutes, once),
//   to send to POST /api/owner/session as { code }. Only where texting is on and ownerMobile is set.
//   JSON → OwnerCodeResponse (lib/types/texting.ts), or the ApiError envelope; a form post from
//   /console/unlock → 303 /console/unlock?code=sent (or ?error=<reason>). See docs/texting.md.

export async function POST(request: Request) {
  // Reads the environment and the database: request-time only, never prerendered.
  await connection();
  return ownerCodePost(request);
}
