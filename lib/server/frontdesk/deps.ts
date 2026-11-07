import { systemClock } from "../clock";
import { createLogNotifier } from "../notify/log-notifier";
import { createMemoryStore } from "./memory-store";
import { createPostgresStore } from "./postgres-store";
import type { FrontDeskDeps } from "./service";

// The one place that decides where Front Desk's data comes from. Every route uses getFrontDeskDeps().
//
//   DATABASE_URL set              → Postgres
//   unset, not on Vercel          → in-memory demo data (one console warning)
//   unset, on Vercel (VERCEL set) → configuration error; a deployment never serves fake data

/** Front Desk is deployed without the settings it needs. Surfaces as an `internal` error; the log says why. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

type Env = Record<string, string | undefined>;

/** Build deps from `env`, without caching. Exported for tests; the app uses getFrontDeskDeps(). */
export function createFrontDeskDeps(env: Env, warn: (message: string) => void = console.warn): FrontDeskDeps {
  const clock = systemClock;
  const notifier = createLogNotifier();
  const url = env.DATABASE_URL?.trim();

  if (url) {
    const db = createPostgresStore(url);
    return { clock, notifier, catalog: db, store: db };
  }
  if (env.VERCEL) {
    throw new ConfigurationError(
      "DATABASE_URL is not set. Set it in the Vercel project's environment variables (Preview and Production) " +
        "to the Supabase transaction pooler connection string (port 6543). See docs/database.md.",
    );
  }
  warn(
    "[frontdesk] DATABASE_URL is not set: using in-memory demo data. Bookings are lost when the server restarts. " +
      "See docs/database.md to use Postgres.",
  );
  const memory = createMemoryStore({ clock });
  return { clock, notifier, catalog: memory, store: memory };
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
