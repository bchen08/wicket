import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigurationError, createFrontDeskDeps } from "./deps";
import { closePostgresClients } from "./postgres-store";

afterAll(async () => {
  await closePostgresClients();
});

describe("createFrontDeskDeps", () => {
  it("uses Postgres when DATABASE_URL is set (without connecting yet)", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps({ DATABASE_URL: "postgres://user:pass@127.0.0.1:6543/postgres", VERCEL: "1" }, warn);
    expect(deps.catalog).toBe(deps.store);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to in-memory demo data locally, with one warning", async () => {
    const warn = vi.fn();
    const deps = createFrontDeskDeps({}, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL is not set/);
    expect(await deps.catalog.getShop("harts")).toMatchObject({ name: "Hart's Barbers" });
  });

  it("treats a blank DATABASE_URL as unset", () => {
    const warn = vi.fn();
    createFrontDeskDeps({ DATABASE_URL: "  " }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses to serve fake data on Vercel: throws a configuration error", () => {
    const warn = vi.fn();
    expect(() => createFrontDeskDeps({ VERCEL: "1" }, warn)).toThrow(ConfigurationError);
    expect(() => createFrontDeskDeps({ VERCEL: "1" }, warn)).toThrow(/DATABASE_URL is not set.*6543/);
    expect(warn).not.toHaveBeenCalled();
  });
});
