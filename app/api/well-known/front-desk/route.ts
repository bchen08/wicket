import { connection } from "next/server";
import { discoveryGet } from "@/lib/server/frontdesk/web-http";

// GET /.well-known/front-desk.json (next.config.ts rewrites it here) — where agents find Front Desk: the
// MCP endpoint, the web API base and agents.md, on the request's origin (FrontDeskDiscovery in
// lib/types/web-booking.ts). Reads no data. Public. See docs/web-booking.md.
export async function GET(request: Request) {
  // Built from the request's origin: request-time only, never prerendered.
  await connection();
  return discoveryGet(request);
}
