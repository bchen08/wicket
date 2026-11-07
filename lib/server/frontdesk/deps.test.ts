import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigurationError, consentConfigFromEnv, createFrontDeskDeps, DEV_PHONE_PEPPER } from "./deps";
import { closePostgresClients } from "./postgres-store";

afterAll(async () => {
  await closePostgresClients();
});

/** 32+ characters, like `openssl rand -base64 32`. */
const PEPPER = "m3Jm2Q6rN0Yb9Vx4Lc8Ks1Tq5Wz7Hd2Pf6Ga0Ue3Rj=";
/** What a Vercel deployment provides on its own. */
const VERCEL_ENV_VARS = { VERCEL: "1", VERCEL_URL: "emergent-abc123.vercel.app" };

describe("createFrontDeskDeps", () => {
  it("uses Postgres when DATABASE_URL is set (without connecting yet)", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps(
      { DATABASE_URL: "postgres://user:pass@127.0.0.1:6543/postgres", ...VERCEL_ENV_VARS, PHONE_HMAC_PEPPER: PEPPER },
      warn,
    );
    expect(deps.catalog).toBe(deps.store);
    expect(deps.consent).toEqual({ publicBaseUrl: "https://emergent-abc123.vercel.app", phonePepper: PEPPER, devCodes: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to in-memory demo data locally, with one warning", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps({ PHONE_HMAC_PEPPER: PEPPER }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL is not set/);
    expect(await deps.catalog.getShop("harts")).toMatchObject({ name: "Hart's Barbers" });
    expect(deps.consent.publicBaseUrl).toBe("http://localhost:3000");
  });

  it("warns once more locally without PHONE_HMAC_PEPPER, and uses the dev pepper", () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps({}, warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toMatch(/PHONE_HMAC_PEPPER is not set/);
    expect(deps.consent.phonePepper).toBe(DEV_PHONE_PEPPER);
  });

  it("treats a blank DATABASE_URL as unset", () => {
    const warn = vi.fn();
    createFrontDeskDeps({ DATABASE_URL: "  ", PHONE_HMAC_PEPPER: PEPPER }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses to serve fake data on Vercel: throws a configuration error", () => {
    const warn = vi.fn();
    const env = { ...VERCEL_ENV_VARS, PHONE_HMAC_PEPPER: PEPPER };
    expect(() => createFrontDeskDeps(env, warn)).toThrow(ConfigurationError);
    expect(() => createFrontDeskDeps(env, warn)).toThrow(/DATABASE_URL is not set.*6543/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails with a clear configuration error on Vercel without PHONE_HMAC_PEPPER", () => {
    const warn = vi.fn();
    const env = { DATABASE_URL: "postgres://user:pass@127.0.0.1:6543/postgres", ...VERCEL_ENV_VARS };
    expect(() => createFrontDeskDeps(env, warn)).toThrow(ConfigurationError);
    expect(() => createFrontDeskDeps(env, warn)).toThrow(/PHONE_HMAC_PEPPER is not set/);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("consentConfigFromEnv", () => {
  describe("PUBLIC_BASE_URL", () => {
    it("defaults to http://localhost:3000 off Vercel", () => {
      expect(consentConfigFromEnv({ PHONE_HMAC_PEPPER: PEPPER }).publicBaseUrl).toBe("http://localhost:3000");
    });

    it("falls back to https://${VERCEL_URL} on Vercel when unset", () => {
      expect(consentConfigFromEnv({ ...VERCEL_ENV_VARS, PHONE_HMAC_PEPPER: PEPPER }).publicBaseUrl).toBe(
        "https://emergent-abc123.vercel.app",
      );
    });

    it("prefers PUBLIC_BASE_URL over VERCEL_URL, trimmed and without a trailing slash", () => {
      const env = { ...VERCEL_ENV_VARS, PHONE_HMAC_PEPPER: PEPPER, PUBLIC_BASE_URL: "  https://frontdesk.example.com/  " };
      expect(consentConfigFromEnv(env).publicBaseUrl).toBe("https://frontdesk.example.com");
    });

    it("keeps a path, without its trailing slashes", () => {
      const env = { PHONE_HMAC_PEPPER: PEPPER, PUBLIC_BASE_URL: "https://example.com/frontdesk//" };
      expect(consentConfigFromEnv(env).publicBaseUrl).toBe("https://example.com/frontdesk");
    });

    it.each([
      ["not a URL", "frontdesk.example.com"],
      ["another scheme", "ftp://frontdesk.example.com"],
      ["a query", "https://frontdesk.example.com/?x=1"],
      ["a fragment", "https://frontdesk.example.com/#top"],
      ["credentials", "https://user:pass@frontdesk.example.com"],
    ])("rejects %s with a configuration error", (_label, value) => {
      expect(() => consentConfigFromEnv({ PHONE_HMAC_PEPPER: PEPPER, PUBLIC_BASE_URL: value })).toThrow(ConfigurationError);
    });

    it("is a configuration error on Vercel with neither PUBLIC_BASE_URL nor VERCEL_URL", () => {
      expect(() => consentConfigFromEnv({ VERCEL: "1", PHONE_HMAC_PEPPER: PEPPER })).toThrow(/PUBLIC_BASE_URL is not set/);
    });
  });

  describe("PHONE_HMAC_PEPPER", () => {
    it("is used as given, trimmed", () => {
      const warn = vi.fn();
      expect(consentConfigFromEnv({ PHONE_HMAC_PEPPER: `  ${PEPPER} ` }, warn).phonePepper).toBe(PEPPER);
      expect(warn).not.toHaveBeenCalled();
    });

    it("missing on Vercel → ConfigurationError that says how to fix it", () => {
      const warn = vi.fn();
      expect(() => consentConfigFromEnv({ ...VERCEL_ENV_VARS }, warn)).toThrow(ConfigurationError);
      expect(() => consentConfigFromEnv({ ...VERCEL_ENV_VARS, PHONE_HMAC_PEPPER: "  " }, warn)).toThrow(
        /PHONE_HMAC_PEPPER is not set.*Vercel.*32 random bytes/,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("too short → ConfigurationError, on Vercel and locally", () => {
      expect(() => consentConfigFromEnv({ ...VERCEL_ENV_VARS, PHONE_HMAC_PEPPER: "short" })).toThrow(/too short/);
      expect(() => consentConfigFromEnv({ PHONE_HMAC_PEPPER: "x".repeat(31) })).toThrow(ConfigurationError);
      expect(consentConfigFromEnv({ PHONE_HMAC_PEPPER: "x".repeat(32) }).phonePepper).toBe("x".repeat(32));
    });

    it("missing locally → the dev pepper, with a warning", () => {
      const warn = vi.fn();
      expect(consentConfigFromEnv({}, warn).phonePepper).toBe(DEV_PHONE_PEPPER);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/PHONE_HMAC_PEPPER is not set/);
    });
  });

  describe("FRONTDESK_DEV_CODES", () => {
    it.each<[string, Record<string, string>, boolean]>([
      ["=1 locally", { FRONTDESK_DEV_CODES: "1" }, true],
      ["=1 on a Vercel preview", { ...VERCEL_ENV_VARS, VERCEL_ENV: "preview", FRONTDESK_DEV_CODES: "1" }, true],
      ["=1 on Vercel production", { ...VERCEL_ENV_VARS, VERCEL_ENV: "production", FRONTDESK_DEV_CODES: "1" }, false],
      ["=1 locally with VERCEL_ENV=production", { VERCEL_ENV: "production", FRONTDESK_DEV_CODES: "1" }, false],
      ["unset", {}, false],
      ["=0", { FRONTDESK_DEV_CODES: "0" }, false],
      ["=true", { FRONTDESK_DEV_CODES: "true" }, false],
    ])("devCodes with FRONTDESK_DEV_CODES%s → %s", (_label, env, expected) => {
      expect(consentConfigFromEnv({ PHONE_HMAC_PEPPER: PEPPER, ...env }).devCodes).toBe(expected);
    });

    it("unset FRONTDESK_DEV_CODES on a preview → false", () => {
      expect(consentConfigFromEnv({ ...VERCEL_ENV_VARS, VERCEL_ENV: "preview", PHONE_HMAC_PEPPER: PEPPER }).devCodes).toBe(false);
    });
  });
});
