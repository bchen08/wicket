import { connection } from "next/server";
import { authorizationServerMetadataGet, corsPreflight } from "@/lib/server/oauth/http";

// GET /.well-known/oauth-authorization-server (next.config.ts rewrites it here) — RFC 8414 authorization server
// metadata: endpoints, PKCE S256, Client ID Metadata Documents, registration. Built from the request's origin.
// Public. See docs/connector-signin.md.
export async function GET(request: Request) {
  await connection();
  return authorizationServerMetadataGet(request);
}

export function OPTIONS() {
  return corsPreflight();
}
