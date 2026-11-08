import { systemClock } from "../clock";
import { createNotifier } from "../notify/notifier";
import { createMemoryStore } from "./memory-store";
import { createPostgresStore } from "./postgres-store";
import type { FrontDeskDeps } from "./service";

// The one place that decides where Front Desk's data comes from and reads its settings. Every route
// uses getFrontDeskDeps().
//
//   DATABASE_URL set              → Postgres
//   unset, not on Vercel          → in-memory demo data (one console warning)
//   unset, on Vercel (VERCEL set) → configuration error; a deployment never serves fake data
//
// Approval links need no setting: each route sets deps.baseUrl to the origin of the request it serves
// (withRequestOrigin in service.ts).
//
// Owner alerts: RESEND_API_KEY set (Production only) → email to the shop's ownerEmail; otherwise, or for a
// shop without an ownerEmail, a log line. See lib/server/notify/notifier.ts.

/** Front Desk is deployed without the settings it needs. Surfaces as an `internal` error; the log says why. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

type Env = Record<string, string | undefined>;

/** deps.baseUrl until a route sets it to its request's origin. */
export const LOCAL_BASE_URL = "http://localhost:3000";

/** Build deps from `env`, without caching. Exported for tests; the app uses getFrontDeskDeps(). */
export function createFrontDeskDeps(env: Env, warn: (message: string) => void = console.warn): FrontDeskDeps {
  const clock = systemClock;
  const notifier = createNotifier({ resendApiKey: env.RESEND_API_KEY });
  const url = env.DATABASE_URL?.trim();

  if (!url && env.VERCEL) {
    throw new ConfigurationError(
      "DATABASE_URL is not set. Set it in the Vercel project's environment variables (Preview and Production) " +
        "to the Supabase transaction pooler connection string (port 6543). See docs/database.md.",
    );
  }
  const baseUrl = LOCAL_BASE_URL;
  if (url) {
    const db = createPostgresStore(url);
    return { clock, notifier, baseUrl, catalog: db, store: db };
  }
  warn(
    "[frontdesk] DATABASE_URL is not set: using in-memory demo data. Bookings are lost when the server restarts. " +
      "See docs/database.md to use Postgres.",
  );
  const memory = createMemoryStore({ clock });
  return { clock, notifier, baseUrl, catalog: memory, store: memory };
}

// Cached on globalThis, not in a module variable: Next.js can load this module once per route
// bundle, and every route must see the same in-memory bookings in `pnpm dev`.
const cache = globalThis as typeof globalThis & { __frontDeskDeps?: FrontDeskDeps };

/**
 * Front Desk's dependencies for this process, built on first use and reused after that (so the
 * in-memory store keeps its bookings between requests, and Postgres reuses its client).
 * Call it at request time, never at module load: on Vercel without DATABASE_URL it throws.
 */
export function getFrontDeskDeps(): FrontDeskDeps {
  cache.__frontDeskDeps ??= createFrontDeskDeps(process.env);
  return cache.__frontDeskDeps;
}
