import { connection } from "next/server";
import { corsPreflight, tokenPost } from "@/lib/server/oauth/http";

// POST /api/oauth/token — authorization_code (with the PKCE verifier) and refresh_token grants, form-encoded.
// Public clients, no secret. See docs/connector-signin.md.
export async function POST(request: Request) {
  await connection();
  return tokenPost(request);
}

export function OPTIONS() {
  return corsPreflight();
}
