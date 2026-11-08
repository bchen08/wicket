import { connection } from "next/server";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { poppyGet } from "@/lib/server/identity/agent";

// GET /.well-known/poppy.json (next.config.ts rewrites it here) — the PAP 0.4 discovery document for the shop
// Front Desk serves, pointing at this deployment's MCP endpoint (PoppyDocument in lib/types/agents.ts).
// Public. See docs/agent-identity.md.
export async function GET(request: Request) {
  // Built from the request's origin: request-time only, never prerendered.
  await connection();
  return poppyGet(getFrontDeskDeps, request);
}
