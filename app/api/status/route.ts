import { connection } from "next/server";
import { statusResponse } from "@/lib/server/frontdesk/status";

// GET /api/status — what this deployment is and whether it's ready to verify (StatusResponse in
// lib/types/frontdesk.ts): environment, commit, database (reachable, schema current, Preview or not),
// owner access, and one sentence per problem saying what to fix. Always 200, never cached. Public: it
// shows no secret values. `pnpm smoke` reads it first (docs/VERIFIER.md).
export async function GET(request: Request) {
  // Reads the environment and the database: request-time only, never prerendered.
  await connection();
  return statusResponse(request, process.env);
}
