import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, ApiErrorCode, BookingsResponse, ServicesResponse } from "../../types/frontdesk";
import { ConfigurationError } from "./deps";
import { FrontDeskError } from "./errors";
import { bookingsResponse, errorResponse, servicesResponse, STATUS } from "./http";
import type { InitialBooking } from "./memory-store";
import { memoryDeps } from "./test-support";

// The handlers behind the public GET /api/shops/[shop]/services and /bookings (no token), and the
// error-code → status mapping every /api/shops/* route shares. The owner routes are in owner.test.ts.
// The route files only add `await connection()` and read the [shop] param.
// "Now" is Mon 9 Nov 2026, noon in New York: the bookings window is 2 Nov 12:00 → 9 Dec 12:00.

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
        booking("2026-11-02T10:00:00-05:00", "2026-11-02T10:30:00-05:00"), // 7 days and 2 hours ago: too old
        booking("2026-12-10T10:00:00-05:00", "2026-12-10T10:30:00-05:00"), // 31 days ahead: too far
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

describe("error status mapping", () => {
  it.each<[ApiErrorCode, number]>([
    ["invalid_request", 400],
    ["unauthorized", 401],
    ["not_found", 404],
    ["booking_not_found", 404],
    ["slot_taken", 409],
    ["paused", 409],
    ["not_cancellable", 409],
    ["outside_hours", 422],
    ["too_soon", 422],
    ["too_far", 422],
    ["outside_mandate", 422],
    ["approval_closed", 409],
    ["approval_expired", 410],
  ])("%s → %i with the ApiError envelope", async (code, status) => {
    expect(STATUS[code]).toBe(status);
    const res = errorResponse(new FrontDeskError(code, "Something specific went wrong.", "Do the specific thing.", { x: 1 }));
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code, message: "Something specific went wrong.", next_action: "Do the specific thing.", details: { x: 1 } },
    });
  });

  it("maps an unexpected error to 500 internal without leaking it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse(new Error("secret stack detail"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
