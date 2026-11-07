import { getSchedule } from "@/lib/server/schedule";
import type { ScheduleResponse } from "@/lib/types/schedule";

// GET /api/schedule — the conference schedule, sorted by start time.
export function GET() {
  const body: ScheduleResponse = getSchedule();
  return Response.json(body);
}
