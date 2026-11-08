import { connection } from "next/server";
import { ownerSessionDelete, ownerSessionGet, ownerSessionPost } from "@/lib/server/frontdesk/owner-session";

// POST /api/owner/session — trade the shop's access code (OWNER_API_TOKEN) for the fd_owner cookie:
//   JSON (OwnerSessionRequest → OwnerSessionResponse), or a form post from /console/unlock
//   (303 → /console, or → /console/unlock?error=1 on a wrong token).
// GET /api/owner/session — whether this browser holds the cookie (OwnerSessionResponse).
// DELETE /api/owner/session — sign out: clears the cookie (OwnerSessionResponse).
// Types in lib/types/frontdesk.ts. Errors use the ApiError envelope.
// Stub. TODO(ring-2): owner sign-in by texted code replaces this.

export async function POST(request: Request) {
  // Reads the environment and the caller's cookie: request-time only, never prerendered.
  await connection();
  return ownerSessionPost(request);
}

export async function GET(request: Request) {
  await connection();
  return ownerSessionGet(request);
}

export async function DELETE(request: Request) {
  await connection();
  return ownerSessionDelete(request);
}
