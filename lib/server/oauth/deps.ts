import type { Clock } from "../clock";
import type { ShopCatalog } from "../frontdesk/catalog";
import { ConfigurationError, getFrontDeskDeps } from "../frontdesk/deps";
import { createMemorySigninStore } from "./memory-store";
import { createPostgresSigninStore } from "./postgres-store";
import type { SigninStore } from "./store";

// Where connector sign-in's data comes from: the same rule as Front Desk's (lib/server/frontdesk/deps.ts).
//   DATABASE_URL set              → Postgres (migration 0008_signin.sql)
//   unset, not on Vercel          → in memory (lost on restart, like the demo bookings)
//   unset, on Vercel              → configuration error

/** What the sign-in use cases need. Tests build it with the in-memory store and a fixed clock. */
export type SigninDeps = {
  clock: Clock;
  /** For the shop's name on /signin. */
  catalog: Pick<ShopCatalog, "getShop">;
  store: SigninStore;
  /** Fetches Client ID Metadata Documents. globalThis.fetch in the app; tests pass a fake. */
  fetch: typeof fetch;
  /** The origin this deployment is served from, without a trailing slash: the issuer. */
  baseUrl: string;
};

type Env = Record<string, string | undefined>;

/** The sign-in store for `env`, without caching. Exported for tests; the app uses getSigninStore(). */
export function createSigninStore(env: Env): SigninStore {
  const url = env.DATABASE_URL?.trim();
  if (url) return createPostgresSigninStore(url);
  if (env.VERCEL) {
    throw new ConfigurationError("DATABASE_URL is not set, so connector sign-in has nowhere to store customers and tokens.");
  }
  return createMemorySigninStore();
}

// Cached on globalThis (like Front Desk's deps) so every route sees the same in-memory sign-ins in `pnpm dev`.
const cache = globalThis as typeof globalThis & { __signinStore?: SigninStore };

/** This process's sign-in store, built on first use. Call it at request time, never at module load. */
export function getSigninStore(): SigninStore {
  cache.__signinStore ??= createSigninStore(process.env);
  return cache.__signinStore;
}

/**
 * The sign-in deps: Front Desk's clock and catalog, the sign-in store, and `origin` as the issuer (routes
 * pass their request's origin, so previews and production each issue for themselves with no setting).
 */
export function getSigninDeps(origin: string): SigninDeps {
  const frontDesk = getFrontDeskDeps();
  return {
    clock: frontDesk.clock,
    catalog: frontDesk.catalog,
    store: getSigninStore(),
    fetch: globalThis.fetch,
    baseUrl: origin,
  };
}
