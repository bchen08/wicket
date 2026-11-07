import { systemClock } from "../clock";
import { createLogCodeSender } from "../consent/code-sender";
import { MIN_PEPPER_LENGTH, type ConsentConfig } from "../consent/config";
import { createLogNotifier } from "../notify/log-notifier";
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
// Consent (Ring 1b):
//   PUBLIC_BASE_URL      the approval links' origin. Default: http://localhost:3000 locally,
//                        https://${VERCEL_URL} on Vercel.
//   PHONE_HMAC_PEPPER    the key phone numbers are HMACed with. Required on Vercel (configuration
//                        error without it); locally a fixed dev pepper, with a warning.
//   FRONTDESK_DEV_CODES  "1": the code request's response includes the code. Ignored on Vercel production.

/** Front Desk is deployed without the settings it needs. Surfaces as an `internal` error; the log says why. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

type Env = Record<string, string | undefined>;

/** Used only off Vercel when PHONE_HMAC_PEPPER is unset. Phone HMACs made with it mean nothing elsewhere. */
export const DEV_PHONE_PEPPER = "front-desk-local-dev-pepper-not-for-production";

const LOCAL_BASE_URL = "http://localhost:3000";

/** PUBLIC_BASE_URL, or its fallback, checked and without a trailing slash. */
function publicBaseUrl(env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  const vercelUrl = env.VERCEL_URL?.trim();
  let value: string;
  if (configured) value = configured;
  else if (!env.VERCEL) value = LOCAL_BASE_URL;
  else if (vercelUrl) value = `https://${vercelUrl}`;
  else {
    throw new ConfigurationError(
      "PUBLIC_BASE_URL is not set, and neither is VERCEL_URL. Set PUBLIC_BASE_URL in the Vercel project's environment " +
        "variables to the deployment's origin, e.g. https://frontdesk.example.com. See docs/database.md.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`PUBLIC_BASE_URL must be an absolute URL like https://frontdesk.example.com, got "${value}".`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new ConfigurationError(
      `PUBLIC_BASE_URL must be a plain http(s) origin (optionally with a path), without a query, fragment or credentials, got "${value}".`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The consent settings from `env`. Throws ConfigurationError for a missing or malformed setting. */
export function consentConfigFromEnv(env: Env, warn: (message: string) => void = console.warn): ConsentConfig {
  const base = publicBaseUrl(env);
  const pepper = env.PHONE_HMAC_PEPPER?.trim();
  let phonePepper: string;
  if (pepper) {
    if (pepper.length < MIN_PEPPER_LENGTH) {
      throw new ConfigurationError(
        `PHONE_HMAC_PEPPER is too short (at least ${MIN_PEPPER_LENGTH} characters). Generate 32 random bytes, e.g. ` +
          "`openssl rand -base64 32`. See docs/database.md.",
      );
    }
    phonePepper = pepper;
  } else if (env.VERCEL) {
    throw new ConfigurationError(
      "PHONE_HMAC_PEPPER is not set. Set it in the Vercel project's environment variables (Preview and Production) to " +
        "32 random bytes, e.g. the output of `openssl rand -base64 32`, and never change it afterwards: verified " +
        "customers are found by it. See docs/database.md.",
    );
  } else {
    warn("[frontdesk] PHONE_HMAC_PEPPER is not set: using a fixed local development pepper. Never do this on a deployment.");
    phonePepper = DEV_PHONE_PEPPER;
  }
  // Never in Vercel production, whatever FRONTDESK_DEV_CODES says.
  const devCodes = env.FRONTDESK_DEV_CODES?.trim() === "1" && env.VERCEL_ENV !== "production";
  return { publicBaseUrl: base, phonePepper, devCodes };
}

/** Build deps from `env`, without caching. Exported for tests; the app uses getFrontDeskDeps(). */
export function createFrontDeskDeps(env: Env, warn: (message: string) => void = console.warn): FrontDeskDeps {
  const clock = systemClock;
  const notifier = createLogNotifier();
  const codeSender = createLogCodeSender();
  const url = env.DATABASE_URL?.trim();

  if (!url && env.VERCEL) {
    throw new ConfigurationError(
      "DATABASE_URL is not set. Set it in the Vercel project's environment variables (Preview and Production) " +
        "to the Supabase transaction pooler connection string (port 6543). See docs/database.md.",
    );
  }
  const consent = consentConfigFromEnv(env, warn);
  if (url) {
    const db = createPostgresStore(url);
    return { clock, notifier, codeSender, consent, catalog: db, store: db };
  }
  warn(
    "[frontdesk] DATABASE_URL is not set: using in-memory demo data. Bookings are lost when the server restarts. " +
      "See docs/database.md to use Postgres.",
  );
  const memory = createMemoryStore({ clock });
  return { clock, notifier, codeSender, consent, catalog: memory, store: memory };
}

// Cached on globalThis, not in a module variable: Next.js can load this module once per route
// bundle, and every route must see the same in-memory bookings in `pnpm dev`.
const cache = globalThis as typeof globalThis & { __frontDeskDeps?: FrontDeskDeps };

/**
 * Front Desk's dependencies for this process, built on first use and reused after that (so the
 * in-memory store keeps its bookings between requests, and Postgres reuses its client).
 * Call it at request time, never at module load: on Vercel without DATABASE_URL or PHONE_HMAC_PEPPER
 * it throws.
 */
export function getFrontDeskDeps(): FrontDeskDeps {
  cache.__frontDeskDeps ??= createFrontDeskDeps(process.env);
  return cache.__frontDeskDeps;
}
