import type { StatusResponse } from "../../types/frontdesk";
import { getFrontDeskDeps } from "./deps";
import { NO_STORE } from "./http";
import { configuredOwnerToken } from "./owner-auth";
import { getPostgresClient } from "./postgres-store";
import { missingFromSchema, REQUIRED_TABLES, type PresentColumn } from "./schema";

// GET /api/status: the deployment reports its own state, so a verifier on any machine can tell "the
// environment isn't ready" apart from "the code is broken". `pnpm smoke` reads it first.
// Never put a secret value or a connection string in the response: database errors are redacted.

type Env = Record<string, string | undefined>;
type Environment = StatusResponse["environment"];
type DatabaseStatus = StatusResponse["database"];

/** The shop the checks read: the one the MCP tools serve (DEFAULT_SHOP_SLUG in mcp.ts). */
export const STATUS_SHOP_SLUG = "harts";

/** The shop name's ending that marks the Preview database (docs/database.md). */
export const PREVIEW_SHOP_SUFFIX = "(preview)";

/** How long each database query gets before the database counts as unreachable. */
export const STATUS_DB_TIMEOUT_MS = 8_000;

/** What the status check asks the database. */
export interface DatabaseProbe {
  /** The (table, column) pairs that exist in the `public` schema, among `tables`. */
  columns(tables: readonly string[]): Promise<PresentColumn[]>;
  /** The name of the shop with this slug, or null when there is none. */
  shopName(slug: string): Promise<string | null>;
}

/** A DatabaseProbe over Postgres, on the same shared client the stores use. */
export function postgresProbe(url: string): DatabaseProbe {
  const sql = getPostgresClient(url);
  return {
    async columns(tables) {
      const rows = await sql<{ table_name: string; column_name: string }[]>`
        select table_name::text as table_name, column_name::text as column_name
        from information_schema.columns
        where table_schema = 'public' and table_name in ${sql([...tables])}
      `;
      return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
    },
    async shopName(slug) {
      const rows = await sql<{ name: string }[]>`select name from shops where slug = ${slug}`;
      return rows[0]?.name ?? null;
    },
  };
}

export type StatusOptions = {
  /** Inspects the database at DATABASE_URL. Default: postgresProbe. */
  probe?: (url: string) => DatabaseProbe;
  /** In-memory mode's shop lookup. Default: the in-memory catalog (getFrontDeskDeps). */
  memoryShopName?: (slug: string) => Promise<string | null>;
  /** Per query. Default STATUS_DB_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** How owner alerts go out here: email when RESEND_API_KEY is set, else log. Neither is a problem. */
export function toAlertChannel(resendApiKey: string | undefined): StatusResponse["alerts"] {
  return resendApiKey?.trim() ? "email" : "log";
}

/** VERCEL_ENV as one of the three environments; anything else (unset locally) is development. */
export function toEnvironment(vercelEnv: string | undefined): Environment {
  const value = vercelEnv?.trim();
  return value === "production" || value === "preview" ? value : "development";
}

/** VERCEL_GIT_COMMIT_SHA's first 7 characters, or null. */
export function toCommit(sha: string | undefined): string | null {
  const value = sha?.trim().toLowerCase();
  return value ? value.slice(0, 7) : null;
}

/** `text` without the connection string, its password, or anything that looks like a connection string. */
export function redact(text: string, databaseUrl: string | undefined): string {
  let out = text;
  const url = databaseUrl?.trim();
  if (url) {
    out = out.split(url).join("[DATABASE_URL]");
    try {
      const password = new URL(url).password;
      for (const secret of new Set([password, safeDecode(password)])) {
        if (secret.length >= 4) out = out.split(secret).join("[password]");
      }
    } catch {
      // Not a URL: nothing more to take out.
    }
  }
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A database error in one short phrase, redacted. */
function describeError(err: unknown, databaseUrl: string | undefined): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = redact(typeof e?.message === "string" && e.message ? e.message : String(err), databaseUrl);
  const code = typeof e?.code === "string" ? e.code : "";
  const text = code && !message.includes(code) ? `${code}: ${message}` : message;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** `promise`, or a rejection once `ms` have passed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- What to fix, and where (one sentence per problem) ----

const LABEL: Record<Environment, string> = { production: "Production", preview: "Preview", development: "Development" };

/** Where to set an environment variable for this environment. */
function setVariable(name: string, environment: Environment, onVercel: boolean): string {
  return onVercel
    ? `set ${name} for ${LABEL[environment]} in Vercel → Settings → Environment Variables, then redeploy`
    : `set ${name} in .env.local and restart pnpm dev`;
}

/** How to bring this environment's database up to the code's migrations. */
function migrateFix(environment: Environment): string {
  switch (environment) {
    case "preview":
      return "rebuild the Preview database from this branch with GitHub → Actions → Preview database → Run workflow (docs/database.md)";
    case "production":
      return "apply supabase/migrations/ with Supabase → Branches → main → Resync branch (docs/database.md)";
    default:
      return "apply supabase/migrations/ and supabase/seed.sql to the database in DATABASE_URL (docs/database.md)";
  }
}

/** How to load the demo shop into this environment's database. */
function seedFix(environment: Environment): string {
  return environment === "preview"
    ? migrateFix(environment)
    : "run supabase/seed.sql in the Supabase SQL Editor (docs/database.md)";
}

// ---- The check ----

async function inspectDatabase(
  env: Env,
  environment: Environment,
  options: StatusOptions,
  problems: string[],
): Promise<DatabaseStatus> {
  const url = env.DATABASE_URL?.trim();
  const onVercel = Boolean(env.VERCEL);
  const timeoutMs = options.timeoutMs ?? STATUS_DB_TIMEOUT_MS;

  if (!url) {
    if (onVercel) {
      // deps.ts refuses to serve in-memory data on Vercel, so every Front Desk call fails here.
      problems.push(
        `DATABASE_URL isn't set, so every Front Desk call fails: ${setVariable("DATABASE_URL", environment, true)} ` +
          "(the Supabase transaction pooler string, port 6543).",
      );
      return { mode: "memory", reachable: false, shopName: null, writesAllowed: false, schema: "unknown", missing: [] };
    }
    const lookup = options.memoryShopName ?? (async (slug: string) => (await getFrontDeskDeps().catalog.getShop(slug))?.name ?? null);
    const shopName = await lookup(STATUS_SHOP_SLUG);
    if (shopName === null) problems.push(`The in-memory data has no shop "${STATUS_SHOP_SLUG}": check SEED in lib/server/frontdesk/memory-store.ts.`);
    return {
      mode: "memory",
      reachable: true,
      shopName,
      writesAllowed: environment !== "production",
      schema: "current",
      missing: [],
    };
  }

  let probe: DatabaseProbe;
  let present: PresentColumn[];
  try {
    probe = (options.probe ?? postgresProbe)(url);
    present = await withTimeout(probe.columns(REQUIRED_TABLES), timeoutMs);
  } catch (err) {
    const where = onVercel
      ? `DATABASE_URL for ${LABEL[environment]} in Vercel → Settings → Environment Variables`
      : "DATABASE_URL in .env.local";
    problems.push(
      `The database didn't answer (${describeError(err, url)}): check ${where}, and that the Supabase project ` +
        "isn't paused (restore it from the Supabase dashboard).",
    );
    return { mode: "postgres", reachable: false, shopName: null, writesAllowed: false, schema: "unknown", missing: [] };
  }

  const missing = missingFromSchema(present);
  if (missing.length > 0) {
    problems.push(`The database schema is outdated, missing ${missing.join(", ")}: ${migrateFix(environment)}.`);
  }

  let shopName: string | null = null;
  const shopReadable = !missing.some((m) => m === "shops" || m === "shops.slug" || m === "shops.name");
  if (shopReadable) {
    try {
      shopName = await withTimeout(probe.shopName(STATUS_SHOP_SLUG), timeoutMs);
      if (shopName === null) problems.push(`The database has no shop "${STATUS_SHOP_SLUG}": ${seedFix(environment)}.`);
    } catch (err) {
      problems.push(`Reading the shop "${STATUS_SHOP_SLUG}" failed (${describeError(err, url)}): ${migrateFix(environment)}.`);
    }
  }

  const markedPreview = shopName !== null && shopName.endsWith(PREVIEW_SHOP_SUFFIX);
  if (environment === "preview" && shopName !== null && !markedPreview) {
    problems.push(
      `This preview isn't on the Preview database (the shop is "${shopName}", not "… ${PREVIEW_SHOP_SUFFIX}"), so it may be ` +
        "production's: set DATABASE_URL for Preview in Vercel to the emergent-preview project's transaction pooler string, " +
        "or rebuild it with GitHub → Actions → Preview database → Run workflow.",
    );
  }
  if (environment === "production" && markedPreview) {
    problems.push(
      `Production is on the Preview database (the shop is "${shopName}"): set DATABASE_URL for Production in Vercel ` +
        "to the production project's transaction pooler string, then redeploy.",
    );
  }

  return {
    mode: "postgres",
    reachable: true,
    shopName,
    writesAllowed: environment !== "production" && markedPreview,
    schema: missing.length > 0 ? "outdated" : "current",
    missing,
  };
}

/** The deployment's StatusResponse. Never throws for a database problem: it becomes one of `problems`. */
export async function getStatus(env: Env, origin: string, options: StatusOptions = {}): Promise<StatusResponse> {
  const environment = toEnvironment(env.VERCEL_ENV);
  const problems: string[] = [];
  const database = await inspectDatabase(env, environment, options, problems);
  const ownerAccess = configuredOwnerToken(env.OWNER_API_TOKEN) === "" ? "missing" : "configured";
  if (ownerAccess === "missing") {
    problems.push(
      `OWNER_API_TOKEN isn't set, so the owner routes and /console refuse everyone: ` +
        `${setVariable("OWNER_API_TOKEN", environment, Boolean(env.VERCEL))}.`,
    );
  }
  return {
    status: problems.length === 0 ? "ready" : "not_ready",
    environment,
    commit: toCommit(env.VERCEL_GIT_COMMIT_SHA),
    database,
    ownerAccess,
    approvalLinks: { origin },
    alerts: toAlertChannel(env.RESEND_API_KEY),
    problems,
  };
}

/** GET /api/status: always 200 with a StatusResponse, never cached. */
export async function statusResponse(request: Request, env: Env, options: StatusOptions = {}): Promise<Response> {
  const origin = new URL(request.url).origin;
  let body: StatusResponse;
  try {
    body = await getStatus(env, origin, options);
  } catch (err) {
    console.error("[frontdesk/status] status check failed", err);
    body = {
      status: "not_ready",
      environment: toEnvironment(env.VERCEL_ENV),
      commit: toCommit(env.VERCEL_GIT_COMMIT_SHA),
      database: { mode: env.DATABASE_URL?.trim() ? "postgres" : "memory", reachable: false, shopName: null, writesAllowed: false, schema: "unknown", missing: [] },
      ownerAccess: configuredOwnerToken(env.OWNER_API_TOKEN) === "" ? "missing" : "configured",
      approvalLinks: { origin },
      alerts: toAlertChannel(env.RESEND_API_KEY),
      problems: [`The status check itself failed (${describeError(err, env.DATABASE_URL)}): see this deployment's function logs in Vercel.`],
    };
  }
  return Response.json(body, { status: 200, headers: NO_STORE });
}
