import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigurationError, consentConfigFromEnv, createFrontDeskDeps } from "./deps";
import { closePostgresClients } from "./postgres-store";

afterAll(async () => {
  await closePostgresClients();
});

/** What a Vercel deployment provides on its own. */
const VERCEL_ENV_VARS = { VERCEL: "1", VERCEL_URL: "emergent-abc123.vercel.app" };

describe("createFrontDeskDeps", () => {
  it("uses Postgres when DATABASE_URL is set (without connecting yet)", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps(
      { DATABASE_URL: "postgres://user:pass@127.0.0.1:6543/postgres", ...VERCEL_ENV_VARS },
      warn,
    );
    expect(deps.catalog).toBe(deps.store);
    expect(deps.consent).toEqual({ publicBaseUrl: "https://emergent-abc123.vercel.app" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to in-memory demo data locally, with one warning", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps({}, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL is not set/);
    expect(await deps.catalog.getShop("harts")).toMatchObject({ name: "Hart's Barbers" });
    expect(deps.consent.publicBaseUrl).toBe("http://localhost:3000");
  });

  it("treats a blank DATABASE_URL as unset", () => {
    const warn = vi.fn();
    createFrontDeskDeps({ DATABASE_URL: "  " }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses to serve fake data on Vercel: throws a configuration error", () => {
    const warn = vi.fn();
    const env = { ...VERCEL_ENV_VARS };
    expect(() => createFrontDeskDeps(env, warn)).toThrow(ConfigurationError);
    expect(() => createFrontDeskDeps(env, warn)).toThrow(/DATABASE_URL is not set.*6543/);
    expect(warn).not.toHaveBeenCalled();
  });

});

describe("consentConfigFromEnv", () => {
  describe("PUBLIC_BASE_URL", () => {
    it("defaults to http://localhost:3000 off Vercel", () => {
      expect(consentConfigFromEnv({}).publicBaseUrl).toBe("http://localhost:3000");
    });

    it("falls back to https://${VERCEL_URL} on Vercel when unset", () => {
      expect(consentConfigFromEnv({ ...VERCEL_ENV_VARS }).publicBaseUrl).toBe(
        "https://emergent-abc123.vercel.app",
      );
    });

    it("prefers PUBLIC_BASE_URL over VERCEL_URL, trimmed and without a trailing slash", () => {
      const env = { ...VERCEL_ENV_VARS, PUBLIC_BASE_URL: "  https://frontdesk.example.com/  " };
      expect(consentConfigFromEnv(env).publicBaseUrl).toBe("https://frontdesk.example.com");
    });

    it("keeps a path, without its trailing slashes", () => {
      const env = { PUBLIC_BASE_URL: "https://example.com/frontdesk//" };
      expect(consentConfigFromEnv(env).publicBaseUrl).toBe("https://example.com/frontdesk");
    });

    it.each([
      ["not a URL", "frontdesk.example.com"],
      ["another scheme", "ftp://frontdesk.example.com"],
      ["a query", "https://frontdesk.example.com/?x=1"],
      ["a fragment", "https://frontdesk.example.com/#top"],
      ["credentials", "https://user:pass@frontdesk.example.com"],
    ])("rejects %s with a configuration error", (_label, value) => {
      expect(() => consentConfigFromEnv({ PUBLIC_BASE_URL: value })).toThrow(ConfigurationError);
    });

    it("is a configuration error on Vercel with neither PUBLIC_BASE_URL nor VERCEL_URL", () => {
      expect(() => consentConfigFromEnv({ VERCEL: "1" })).toThrow(/PUBLIC_BASE_URL is not set/);
    });
  });

  it("ignores FRONTDESK_DEV_CODES (phone codes are gone until Ring 1c): the config is only the base URL", () => {
    for (const env of [
      { FRONTDESK_DEV_CODES: "1" },
      { ...VERCEL_ENV_VARS, VERCEL_ENV: "preview", FRONTDESK_DEV_CODES: "1" },
      { ...VERCEL_ENV_VARS, VERCEL_ENV: "production", FRONTDESK_DEV_CODES: "1" },
    ]) {
      expect(Object.keys(consentConfigFromEnv(env))).toEqual(["publicBaseUrl"]);
    }
    expect(consentConfigFromEnv({ FRONTDESK_DEV_CODES: "1" })).toEqual({ publicBaseUrl: "http://localhost:3000" });
  });
});
