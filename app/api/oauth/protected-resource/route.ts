import { connection } from "next/server";
import { corsPreflight, protectedResourceGet } from "@/lib/server/oauth/http";

// GET /.well-known/oauth-protected-resource/api/mcp and /.well-known/oauth-protected-resource (next.config.ts
// rewrites both here) — RFC 9728 metadata for the MCP endpoint: its URL, the issuer and the scope. Built from the
// request's origin. Public. See docs/connector-signin.md.
export async function GET(request: Request) {
  await connection();
  return protectedResourceGet(request);
}

export function OPTIONS() {
  return corsPreflight();
}
