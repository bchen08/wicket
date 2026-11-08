import { connection } from "next/server";
import { authorizeGet, authorizePost } from "@/lib/server/oauth/http";

// /api/oauth/authorize — the OAuth authorization endpoint for the MCP connector (docs/connector-signin.md).
// GET checks the request (client, redirect URI, PKCE S256) and sends the person to /signin; POST is the
// /signin form (Allow / Deny), which answers 303 to the client's redirect URI with a code. Where texting is
// on, it first texts the person a code and answers 303 back to /signin to enter it.
export async function GET(request: Request) {
  await connection();
  return authorizeGet(request);
}

export async function POST(request: Request) {
  await connection();
  return authorizePost(request);
}
