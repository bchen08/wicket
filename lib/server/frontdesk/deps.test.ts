import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigurationError, createFrontDeskDeps, LOCAL_BASE_URL } from "./deps";
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
    // Routes set baseUrl to their request's origin; PUBLIC_BASE_URL and VERCEL_URL aren't read.
    expect(deps.baseUrl).toBe("http://localhost:3000");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to in-memory demo data locally, with one warning", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps({}, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL is not set/);
    expect(await deps.catalog.getShop("harts")).toMatchObject({ name: "Hart's Barbers" });
    expect(deps.baseUrl).toBe(LOCAL_BASE_URL);
    expect(LOCAL_BASE_URL).toBe("http://localhost:3000");
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

  it("emails owner alerts only when RESEND_API_KEY is set (and the shop has an ownerEmail); otherwise logs them", () => {
    const alert = { ownerEmail: "dana@example.com" } as Parameters<ReturnType<typeof createFrontDeskDeps>["notifier"]["route"]>[0];
    const withKey = createFrontDeskDeps({ RESEND_API_KEY: "re_test_123" }, vi.fn());
    expect(withKey.notifier.route(alert)).toEqual({ channel: "email", recipient: "dana@example.com" });
    expect(withKey.notifier.route({ ...alert, ownerEmail: null })).toEqual({ channel: "log", recipient: null });
    expect(createFrontDeskDeps({}, vi.fn()).notifier.route(alert)).toEqual({ channel: "log", recipient: null });
  });

  it("ignores PUBLIC_BASE_URL: approval links use the request's origin", () => {
    const deps = createFrontDeskDeps({ PUBLIC_BASE_URL: "https://frontdesk.example.com" }, vi.fn());
    expect(deps.baseUrl).toBe("http://localhost:3000");
  });
});
