import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "./clock";

describe("systemClock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses FRONTDESK_NOW when set", () => {
    vi.stubEnv("FRONTDESK_NOW", "2026-11-07T12:00:00-05:00");
    expect(systemClock.now().toISOString()).toBe("2026-11-07T17:00:00.000Z");
  });

  it("uses real time when FRONTDESK_NOW is empty", () => {
    vi.stubEnv("FRONTDESK_NOW", "");
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("refuses a FRONTDESK_NOW without an offset", () => {
    vi.stubEnv("FRONTDESK_NOW", "2026-11-07T12:00:00");
    expect(() => systemClock.now()).toThrow(/RFC 3339/);
  });
});
