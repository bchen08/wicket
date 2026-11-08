import { connection } from "next/server";
import { corsPreflight, registerPost } from "@/lib/server/oauth/http";

// POST /api/oauth/register — dynamic client registration (RFC 7591), the fallback for clients that don't
// identify themselves with a Client ID Metadata Document. See docs/connector-signin.md.
export async function POST(request: Request) {
  await connection();
  return registerPost(request);
}

export function OPTIONS() {
  return corsPreflight();
}
