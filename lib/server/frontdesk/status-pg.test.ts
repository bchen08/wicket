import { afterAll, describe, expect, it } from "vitest";
import { closePostgresClients } from "./postgres-store";
import { missingFromSchema, REQUIRED_TABLES } from "./schema";
import { getStatus, postgresProbe } from "./status";

// The status check against a real database, when DATABASE_URL_TEST points at one with every migration and
// the seed applied (docs/database.md → Running the Postgres tests). Read-only: it writes nothing.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("status on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to check /api/status against a real database", () => {});
  });
} else {
  describe("status on Postgres (DATABASE_URL_TEST)", () => {
    afterAll(async () => {
      await closePostgresClients();
    });

    it("finds every column REQUIRED_SCHEMA lists in a database with every migration", async () => {
      const present = await postgresProbe(url).columns(REQUIRED_TABLES);
      expect(missingFromSchema(present)).toEqual([]);
    });

    it("reads the seeded shop's name", async () => {
      expect(await postgresProbe(url).shopName("harts")).toMatch(/^Hart's Barbers/);
      expect(await postgresProbe(url).shopName("no-such-shop")).toBeNull();
    });

    it("reports the schema current and the database reachable", async () => {
      const status = await getStatus({ DATABASE_URL: url, OWNER_API_TOKEN: "t" }, "http://localhost:3000");
      expect(status.database).toMatchObject({ mode: "postgres", reachable: true, schema: "current", missing: [] });
    });
  });
}
