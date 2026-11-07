import type { HealthResponse } from "@/lib/types/health";

// GET /api/health — used by the smoke checklist to confirm the deployment is up.
export function GET() {
  const body: HealthResponse = { status: "ok", service: "emergent" };
  return Response.json(body);
}
