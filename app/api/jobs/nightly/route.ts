import { connection } from "next/server";
import { nightlyGet } from "@/lib/server/frontdesk/nightly";

// GET /api/jobs/nightly — the nightly tidy-up (NightlyRunResponse in lib/types/nightly.ts). Vercel Cron calls
// it once a day at 08:00 UTC (vercel.json). For every shop it expires holds and unpaid deposits past their
// deadlines, then completes confirmed bookings that ended more than 3 hours ago, releasing their deposit holds.
// Safe to call again at any time: a second run finds nothing left to do. Public, no secret: it only finishes
// bookings that are already past their time (docs/nightly.md). Errors use the ApiError envelope.

// Each booking may take a Stripe call or two; a day's bookings fit well inside this.
export const maxDuration = 60;

export async function GET(request: Request) {
  // Reads and writes the database: request-time only, never prerendered or cached.
  await connection();
  return nightlyGet(request);
}
