import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, BookingsResponse, ServicesResponse } from "../../types/frontdesk";
import { ConfigurationError } from "./deps";
import { bookingsResponse, servicesResponse } from "./http";
import type { InitialBooking } from "./memory-store";
import { memoryDeps } from "./test-support";

// The handlers behind GET /api/shops/[shop]/services and /bookings. The route files only add
// `await connection()` and read the [shop] param. "Now" is Sat 7 Nov 2026, noon in New York.

const booking = (start: string, end: string, extra: Partial<InitialBooking> = {}): InitialBooking => ({
  shopSlug: "harts",
  serviceId: "haircut",
  staffId: "dana",
  start: new Date(start),
  end: new Date(end),
  customerName: "Test Customer",
  agentName: "test agent",
  ...extra,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/shops/[shop]/services", () => {
  it("returns ServicesResponse", async () => {
    const res = await servicesResponse(() => memoryDeps(), "harts");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ServicesResponse;
    expect(body.shop).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
    expect(body.services.map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard"]);
  });

  it("is 404 with the ApiError envelope for an unknown shop", async () => {
    const res = await servicesResponse(() => memoryDeps(), "nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("not_found");
    expect(body.error.next_action).toMatch(/harts/);
  });
});

describe("GET /api/shops/[shop]/bookings", () => {
  it("returns bookings from 7 days ago to 30 days ahead, any status, sorted by start", async () => {
    const deps = memoryDeps({
      // Inserted out of order on purpose.
      initialBookings: [
        booking("2026-11-20T15:00:00-05:00", "2026-11-20T15:30:00-05:00"),
        booking("2026-11-03T10:00:00-05:00", "2026-11-03T10:30:00-05:00", { status: "cancelled" }),
        booking("2026-11-14T09:00:00-05:00", "2026-11-14T09:30:00-05:00"),
        booking("2026-10-30T10:00:00-04:00", "2026-10-30T10:30:00-04:00"), // 8 days ago: too old
        booking("2026-12-08T10:00:00-05:00", "2026-12-08T10:30:00-05:00"), // 31 days ahead: too far
      ],
    });

    const res = await bookingsResponse(() => deps, "harts");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as BookingsResponse;
    expect(body.shop.slug).toBe("harts");
    expect(body.bookings.map((b) => [b.start, b.status])).toEqual([
      ["2026-11-03T10:00:00-05:00", "cancelled"],
      ["2026-11-14T09:00:00-05:00", "confirmed"],
      ["2026-11-20T15:00:00-05:00", "confirmed"],
    ]);
    expect(body.bookings[0]).toMatchObject({
      serviceName: "Haircut",
      display: "Tue 3 Nov, 10:00 am EST",
      customer: { displayName: "Test Customer", verified: false },
      depositCents: 1000,
    });
  });

  it("returns an empty list for a shop with no bookings", async () => {
    const body = (await (await bookingsResponse(() => memoryDeps(), "harts")).json()) as BookingsResponse;
    expect(body.bookings).toEqual([]);
  });

  it("is 404 with the ApiError envelope for an unknown shop", async () => {
    const res = await bookingsResponse(() => memoryDeps(), "nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error).toMatchObject({ code: "not_found", details: { shop: "nope" } });
  });

  it("is a 500 internal envelope, without leaking the cause, when deps can't be built", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await bookingsResponse(() => {
      throw new ConfigurationError("DATABASE_URL is not set.");
    }, "harts");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });
});
