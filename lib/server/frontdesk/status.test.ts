import { describe, expect, it } from "vitest";
import type { StatusResponse } from "../../types/frontdesk";
import { createMemoryStore } from "./memory-store";
import { REQUIRED_SCHEMA, REQUIRED_TABLES, type PresentColumn } from "./schema";
import { getStatus, redact, statusResponse, type DatabaseProbe, type StatusOptions } from "./status";

// GET /api/status, driven through getStatus and statusResponse with stub databases: no network.

const ORIGIN = "https://emergent-git-claude-24-abc.vercel.app";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PASSWORD = "s3cret-db-password";
const DATABASE_URL = `postgresql://postgres.qaaaxyzvyeigzjqltrlb:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const PREVIEW_SHOP = "Hart's Barbers (preview)";

/** Every column REQUIRED_SCHEMA lists: a database on the current schema. */
const CURRENT: PresentColumn[] = REQUIRED_TABLES.flatMap((table) =>
  REQUIRED_SCHEMA[table].map((column) => ({ table, column })),
);

/** What Vercel sets on a preview deployment, plus the Preview database and the Preview owner token. */
const previewEnv = (extra: Record<string, string | undefined> = {}) => ({
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_SHA: SHA,
  DATABASE_URL,
  OWNER_API_TOKEN: "harts-preview",
  ...extra,
});

/** A stub Postgres: these columns exist, and the shop "harts" has this name (null: no row). */
function database(columns: PresentColumn[], shopName: string | null = PREVIEW_SHOP): StatusOptions {
  const probe: DatabaseProbe = {
    columns: async (tables) => columns.filter((c) => tables.includes(c.table)),
    shopName: async (slug) => (slug === "harts" ? shopName : null),
  };
  return { probe: () => probe };
}

/** A stub Postgres that fails every query with `err`. */
function failingDatabase(err: unknown): StatusOptions {
  const probe: DatabaseProbe = {
    columns: () => Promise.reject(err),
    shopName: () => Promise.reject(err),
  };
  return { probe: () => probe };
}

const memoryOptions: StatusOptions = {
  memoryShopName: async (slug) => (await createMemoryStore().getShop(slug))?.name ?? null,
};

describe("GET /api/status", () => {
  it("in memory mode (pnpm dev without DATABASE_URL) is ready and allows writes", async () => {
    const status = await getStatus({ OWNER_API_TOKEN: "local-token" }, "http://localhost:3000", memoryOptions);
    expect(status).toEqual<StatusResponse>({
      status: "ready",
      environment: "development",
      commit: null,
      database: {
        mode: "memory",
        reachable: true,
        shopName: "Hart's Barbers",
        writesAllowed: true,
        schema: "current",
        missing: [],
      },
      ownerAccess: "configured",
      deposits: "off",
      approvalLinks: { origin: "http://localhost:3000" },
      problems: [],
    });
  });

  it("on a preview with the current Preview database is ready, with the commit's first 7 characters", async () => {
    const status = await getStatus(previewEnv(), ORIGIN, database(CURRENT));
    expect(status).toEqual<StatusResponse>({
      status: "ready",
      environment: "preview",
      commit: "0123456",
      database: {
        mode: "postgres",
        reachable: true,
        shopName: PREVIEW_SHOP,
        writesAllowed: true,
        schema: "current",
        missing: [],
      },
      ownerAccess: "configured",
      deposits: "off",
      approvalLinks: { origin: ORIGIN },
      problems: [],
    });
  });

  it("reports an unreachable database without leaking the connection string or its password", async () => {
    const err = Object.assign(new Error(`connect ECONNREFUSED while connecting to ${DATABASE_URL}`), {
      code: "ECONNREFUSED",
    });
    const status = await getStatus(previewEnv(), ORIGIN, failingDatabase(err));
    expect(status.status).toBe("not_ready");
    expect(status.database).toEqual({
      mode: "postgres",
      reachable: false,
      shopName: null,
      writesAllowed: false,
      schema: "unknown",
      missing: [],
    });
    expect(status.problems).toHaveLength(1);
    // The error code is already in the message, so it isn't repeated in front.
    expect(status.problems[0]).toMatch(/^The database didn't answer \(connect ECONNREFUSED while connecting to \[DATABASE_URL\]\)/);
    expect(status.problems[0]).toMatch(/DATABASE_URL for Preview in Vercel/);
    const json = JSON.stringify(status);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain("postgresql://");
    expect(json).not.toContain("harts-preview");
  });

  it("counts a database that doesn't answer in time as unreachable", async () => {
    const probe: DatabaseProbe = { columns: () => new Promise(() => {}), shopName: () => new Promise(() => {}) };
    const status = await getStatus(previewEnv(), ORIGIN, { probe: () => probe, timeoutMs: 20 });
    expect(status.database.reachable).toBe(false);
    expect(status.problems[0]).toMatch(/no answer within 0\.02 s/);
  });

  it("calls an outdated schema outdated, naming the missing column, and says how to rebuild the Preview database", async () => {
    // The Preview database before the MVP reset: approvals kept a hash instead of the token.
    const old = [
      ...CURRENT.filter((c) => !(c.table === "approvals" && c.column === "token")),
      { table: "approvals", column: "token_hash" },
    ];
    const status = await getStatus(previewEnv(), ORIGIN, database(old));
    expect(status.status).toBe("not_ready");
    expect(status.database).toMatchObject({ reachable: true, schema: "outdated", missing: ["approvals.token"] });
    expect(status.problems).toEqual([
      "The database schema is outdated, missing approvals.token: rebuild the Preview database from this branch with " +
        "GitHub → Actions → Preview database → Run workflow (docs/database.md).",
    ]);
  });

  it("names a missing table by itself, and doesn't read the shop when shops is missing", async () => {
    const status = await getStatus(previewEnv(), ORIGIN, database(CURRENT.filter((c) => c.table !== "shops")));
    expect(status.database).toMatchObject({ schema: "outdated", missing: ["shops"], shopName: null, writesAllowed: false });
  });

  it("reports a missing owner token", async () => {
    const status = await getStatus(previewEnv({ OWNER_API_TOKEN: "  " }), ORIGIN, database(CURRENT));
    expect(status.status).toBe("not_ready");
    expect(status.ownerAccess).toBe("missing");
    expect(status.problems).toEqual([
      "OWNER_API_TOKEN isn't set, so the owner routes and /console refuse everyone: set OWNER_API_TOKEN for Preview " +
        "in Vercel → Settings → Environment Variables, then redeploy.",
    ]);
  });

  it("never allows writes in production, even on a database marked (preview)", async () => {
    const env = previewEnv({ VERCEL_ENV: "production", OWNER_API_TOKEN: "prod-token" });

    const onProduction = await getStatus(env, "https://emergent.vercel.app", database(CURRENT, "Hart's Barbers"));
    expect(onProduction.status).toBe("ready");
    expect(onProduction.database.writesAllowed).toBe(false);

    const onPreviewDb = await getStatus(env, "https://emergent.vercel.app", database(CURRENT, PREVIEW_SHOP));
    expect(onPreviewDb.database.writesAllowed).toBe(false);
    expect(onPreviewDb.status).toBe("not_ready");
    expect(onPreviewDb.problems[0]).toMatch(/^Production is on the Preview database/);

    const inMemory = await getStatus({ VERCEL_ENV: "production", OWNER_API_TOKEN: "t" }, ORIGIN, memoryOptions);
    expect(inMemory.database.writesAllowed).toBe(false);
  });

  it("calls a preview on a database without the (preview) mark not ready, and allows no writes there", async () => {
    const status = await getStatus(previewEnv(), ORIGIN, database(CURRENT, "Hart's Barbers"));
    expect(status.status).toBe("not_ready");
    expect(status.database).toMatchObject({ reachable: true, shopName: "Hart's Barbers", writesAllowed: false });
    expect(status.problems[0]).toMatch(/^This preview isn't on the Preview database \(the shop is "Hart's Barbers"/);
  });

  it("reports a database without the shop", async () => {
    const status = await getStatus(previewEnv(), ORIGIN, database(CURRENT, null));
    expect(status.database).toMatchObject({ shopName: null, writesAllowed: false, schema: "current" });
    expect(status.problems).toEqual([
      'The database has no shop "harts": rebuild the Preview database from this branch with GitHub → Actions → ' +
        "Preview database → Run workflow (docs/database.md).",
    ]);
  });

  it("on Vercel without DATABASE_URL says to set it", async () => {
    const status = await getStatus(previewEnv({ DATABASE_URL: undefined }), ORIGIN);
    expect(status.database).toEqual({
      mode: "memory",
      reachable: false,
      shopName: null,
      writesAllowed: false,
      schema: "unknown",
      missing: [],
    });
    expect(status.problems[0]).toMatch(/^DATABASE_URL isn't set, so every Front Desk call fails: set DATABASE_URL for Preview in Vercel/);
  });
});

describe("statusResponse", () => {
  it("answers 200, no-store, with the request's origin", async () => {
    const res = await statusResponse(new Request(`${ORIGIN}/api/status`), previewEnv(), database(CURRENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as StatusResponse;
    expect(body.status).toBe("ready");
    expect(body.approvalLinks.origin).toBe(ORIGIN);
  });

  it("still answers 200 when the database can't even be set up, without leaking the connection string", async () => {
    const options: StatusOptions = {
      probe: () => {
        throw new Error(`Invalid URL ${DATABASE_URL}`);
      },
    };
    const res = await statusResponse(new Request(`${ORIGIN}/api/status`), previewEnv(), options);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("postgresql://");
    expect((JSON.parse(text) as StatusResponse).database.reachable).toBe(false);
  });
});

describe("redact", () => {
  it("takes out the connection string, its password (raw or URI-decoded), and anything like a connection string", () => {
    const url = "postgres://user:p%40ss-word@host:5432/db";
    expect(redact(`failed ${url}`, url)).toBe("failed [DATABASE_URL]");
    expect(redact("auth failed for p@ss-word", url)).toBe("auth failed for [password]");
    expect(redact("see postgres://other:x@h/db now", undefined)).toBe("see [connection string] now");
  });
});
