import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApiError,
  BlockResponse,
  BlocksResponse,
  Booking,
  BookingDetailResponse,
  BookingsResponse,
  HoursResponse,
  OwnerBookingActionResponse,
  PoliciesResponse,
  ServiceResponse,
  ServicesResponse,
  WeeklyHours,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking } from "../consent/approvals";
import { newApprovalToken, sha256Hex } from "../consent/crypto";
import type { ManageAction } from "../engine/lifecycle";
import { DepositExceedsPriceError } from "./catalog";
import { ConfigurationError } from "./deps";
import {
  blocksDelete,
  blocksGet,
  blocksPost,
  bookingActionPost,
  bookingDetailGet,
  bookingsResponse,
  hoursGet,
  hoursPut,
  policiesGet,
  policiesPut,
  servicePatch,
  servicesPost,
  servicesResponse,
  type OwnerOptions,
} from "./http";
import type { FrontDeskDeps } from "./service";
import { memoryDeps, NOW } from "./test-support";

// The owner routes, through the http.ts handlers the route files call (the routes only add
// `await connection()` and read params). In-memory store; "now" is Mon 9 Nov 2026, noon in New York.
// Owner routes: Authorization: Bearer <OWNER_API_TOKEN>. TODO(ring-2): owner sign-in replaces the token.

const TOKEN = "owner-token-for-tests-0123456789";
const OPTIONS: OwnerOptions = { getToken: () => TOKEN };
const SHOP = "harts";
const RANDOM_UUID = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

/** 5 days ahead of now (Sat 14 Nov), so cancellable by the owner. */
const FUTURE = "2026-11-14T10:00:00-05:00";
/** 2 hours before now: started, so it can be completed or marked a no-show. */
const PAST = "2026-11-09T10:00:00-05:00";
/** The day before now. */
const YESTERDAY = "2026-11-08T10:00:00-05:00";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type RequestInit = {
  /** JSON-encoded as the body. */
  body?: unknown;
  /** Sent as the body as it is. */
  raw?: string;
  /** The Authorization header; null for none. Defaults to the right bearer token. */
  auth?: string | null;
};

function request(method: string, path: string, init: RequestInit = {}): Request {
  const headers: Record<string, string> = {};
  const auth = init.auth === undefined ? `Bearer ${TOKEN}` : init.auth;
  if (auth !== null) headers.authorization = auth;
  let body: string | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://localhost/api/shops/${SHOP}${path}`, { method, headers, body });
}

/** The JSON body, after checking the status (the body is in the failure message). */
async function call<T>(response: Promise<Response>, status = 200): Promise<T> {
  const res = await response;
  const body = (await res.json()) as T;
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return body;
}

async function apiError(response: Promise<Response>, status: number, code: ApiError["error"]["code"]) {
  const body = await call<ApiError>(response, status);
  expect(body.error.code).toBe(code);
  expect(body.error.message).not.toBe("");
  expect(body.error.next_action).not.toBe("");
  return body.error;
}

/** A 400 invalid_request naming `field`, with details.issues starting with it. */
async function invalid(response: Promise<Response>, field: string) {
  const error = await apiError(response, 400, "invalid_request");
  expect(error.details?.field).toBe(field);
  expect((error.details?.issues as { path: string; message: string }[])[0]).toEqual({
    path: field,
    message: error.message,
  });
  return error;
}

type BookingExtra = { minutes?: number; serviceId?: string; depositCents?: number };

/**
 * A hold with dana awaiting approval, made through the store so it has its "booked" event, with a
 * 10-minute deadline from the clock. Returns it and its approval token.
 */
async function createHold(
  deps: FrontDeskDeps,
  start: string,
  extra: BookingExtra = {},
): Promise<{ booking: Booking; token: string }> {
  const s = new Date(start);
  const token = newApprovalToken();
  const booking = await deps.store.createBooking({
    shopSlug: SHOP,
    serviceId: extra.serviceId ?? "haircut",
    staffId: "dana",
    start: s,
    end: new Date(s.getTime() + (extra.minutes ?? 30) * 60_000),
    customerName: "Pat Owner-Test",
    agentName: "test agent",
    depositCents: extra.depositCents ?? 1000,
    approveBy: new Date(deps.clock.now().getTime() + 10 * 60_000),
    approvalTokenHash: sha256Hex(token),
    mandate: null,
  });
  return { booking, token };
}

let phoneSeq = 0;
/** A different phone number for each approval. */
const nextPhone = () => `+1401555${String(1000 + (phoneSeq++ % 9000))}`;

/** The person approves through the approval use case (open the link, approve, giving a phone number). */
async function approve(deps: FrontDeskDeps, token: string, phone = nextPhone()): Promise<Booking> {
  return (await approveBooking(deps, token, { phone })).booking;
}

/** A confirmed booking with dana: a hold the person approved (events: booked, approved). */
async function createBooking(deps: FrontDeskDeps, start: string, extra: BookingExtra = {}): Promise<Booking> {
  return approve(deps, (await createHold(deps, start, extra)).token);
}

/** The events every confirmed booking starts with. */
const BOOKED_THEN_APPROVED = [
  ["booked", "agent"],
  ["approved", "customer"],
];

/** A clock tests can move. */
function movableClock(start: Date = NOW): Clock & { advance(ms: number): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}

const PATH_FOR: Record<ManageAction, string> = { cancel: "cancel", complete: "complete", mark_no_show: "no-show" };

function act(deps: FrontDeskDeps, bookingId: string, action: ManageAction, shop = SHOP) {
  return bookingActionPost(
    () => deps,
    request("POST", `/bookings/${bookingId}/${PATH_FOR[action]}`),
    shop,
    bookingId,
    action,
    OPTIONS,
  );
}

function detail(deps: FrontDeskDeps, bookingId: string, shop = SHOP) {
  return bookingDetailGet(() => deps, request("GET", `/bookings/${bookingId}`), shop, bookingId, OPTIONS);
}

// ---- Auth ----

type Handler = (getDeps: () => FrontDeskDeps, auth: string | null, options?: OwnerOptions) => Promise<Response>;

const HANDLERS: [string, Handler][] = [
  ["GET policies", (g, auth, o) => policiesGet(g, request("GET", "/policies", { auth }), SHOP, o)],
  ["PUT policies", (g, auth, o) => policiesPut(g, request("PUT", "/policies", { auth, body: { paused: true } }), SHOP, o)],
  ["GET hours", (g, auth, o) => hoursGet(g, request("GET", "/hours", { auth }), SHOP, o)],
  [
    "PUT hours",
    (g, auth, o) => hoursPut(g, request("PUT", "/hours", { auth, body: { staffId: "dana", weekly: [] } }), SHOP, o),
  ],
  ["GET blocks", (g, auth, o) => blocksGet(g, request("GET", "/blocks", { auth }), SHOP, o)],
  [
    "POST blocks",
    (g, auth, o) =>
      blocksPost(
        g,
        request("POST", "/blocks", {
          auth,
          body: { staffId: "dana", start: "2026-12-24T00:00:00-05:00", end: "2026-12-27T00:00:00-05:00" },
        }),
        SHOP,
        o,
      ),
  ],
  ["DELETE blocks", (g, auth, o) => blocksDelete(g, request("DELETE", `/blocks?id=${RANDOM_UUID}`, { auth }), SHOP, o)],
  [
    "POST services",
    (g, auth, o) =>
      servicesPost(
        g,
        request("POST", "/services", {
          auth,
          body: { id: "kids-cut", name: "Kids cut", durationMin: 20, priceCents: 2000, depositCents: 0 },
        }),
        SHOP,
        o,
      ),
  ],
  [
    "PATCH services/[id]",
    (g, auth, o) => servicePatch(g, request("PATCH", "/services/haircut", { auth, body: { priceCents: 4000 } }), SHOP, "haircut", o),
  ],
  [
    "GET bookings/[id]",
    (g, auth, o) => bookingDetailGet(g, request("GET", `/bookings/${RANDOM_UUID}`, { auth }), SHOP, RANDOM_UUID, o),
  ],
  ...(["cancel", "complete", "mark_no_show"] as const).map(
    (action): [string, Handler] => [
      `POST bookings/[id]/${PATH_FOR[action]}`,
      (g, auth, o) =>
        bookingActionPost(g, request("POST", `/bookings/${RANDOM_UUID}/${PATH_FOR[action]}`, { auth }), SHOP, RANDOM_UUID, action, o),
    ],
  ),
];

describe("owner auth on every owner route", () => {
  it.each(HANDLERS)("%s: 401 unauthorized without the token, before building deps", async (_name, handler) => {
    for (const auth of [null, "Bearer wrong-token-of-some-length", `Basic ${TOKEN}`, "Bearer "]) {
      const getDeps = vi.fn(() => memoryDeps());
      const res = await handler(getDeps, auth, OPTIONS);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="front-desk-owner"');
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as ApiError;
      expect(body.error).toEqual({
        code: "unauthorized",
        message: "Missing or invalid owner token.",
        next_action: "Send the header Authorization: Bearer <OWNER_API_TOKEN>.",
      });
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(getDeps).not.toHaveBeenCalled();
    }
  });

  it.each(HANDLERS)("%s: 503 when OWNER_API_TOKEN is unset, even with a header, before building deps", async (_name, handler) => {
    for (const configured of [undefined, "", "too-short"]) {
      const getDeps = vi.fn(() => memoryDeps());
      const res = await handler(getDeps, `Bearer ${TOKEN}`, { getToken: () => configured });
      expect(res.status).toBe(503);
      expect(res.headers.get("www-authenticate")).toBeNull();
      const body = (await res.json()) as ApiError;
      expect(body.error.code).toBe("internal");
      expect(body.error.message).toMatch(/OWNER_API_TOKEN is (not set|too short)/);
      expect(body.error.next_action).toMatch(/Set OWNER_API_TOKEN/);
      expect(getDeps).not.toHaveBeenCalled();
    }
  });

  it.each(HANDLERS)("%s: passes auth with the right token", async (_name, handler) => {
    const getDeps = vi.fn(() => memoryDeps());
    const res = await handler(getDeps, `Bearer ${TOKEN}`, OPTIONS);
    expect([401, 503]).not.toContain(res.status);
    expect(getDeps).toHaveBeenCalledTimes(1);
  });

  it("reads OWNER_API_TOKEN from the environment on every request by default", async () => {
    const deps = memoryDeps();
    vi.stubEnv("OWNER_API_TOKEN", TOKEN);
    await call<PoliciesResponse>(policiesGet(() => deps, request("GET", "/policies"), SHOP));
    vi.stubEnv("OWNER_API_TOKEN", "a-different-token-0123456789");
    await apiError(policiesGet(() => deps, request("GET", "/policies"), SHOP), 401, "unauthorized");
    vi.stubEnv("OWNER_API_TOKEN", "");
    await apiError(policiesGet(() => deps, request("GET", "/policies"), SHOP), 503, "internal");
  });

  it("is a 500 internal envelope, without leaking the cause, when deps can't be built after auth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = policiesGet(
      () => {
        throw new ConfigurationError("DATABASE_URL is not set.");
      },
      request("GET", "/policies"),
      SHOP,
      OPTIONS,
    );
    const error = await apiError(res, 500, "internal");
    expect(JSON.stringify(error)).not.toContain("DATABASE_URL");
  });

  it("is 404 not_found for an unknown shop", async () => {
    const error = await apiError(policiesGet(() => memoryDeps(), request("GET", "/policies"), "nope", OPTIONS), 404, "not_found");
    expect(error.details).toEqual({ shop: "nope" });
  });

  it("is 404 not_found for a shop slug containing NUL, without looking it up (Postgres text can't hold U+0000)", async () => {
    const deps = memoryDeps();
    const getShop = vi.spyOn(deps.catalog, "getShop");
    const error = await apiError(policiesGet(() => deps, request("GET", "/policies"), "harts\u0000", OPTIONS), 404, "not_found");
    expect(error.details).toEqual({ shop: "harts\u0000" });
    expect(getShop).not.toHaveBeenCalled();
  });
});

// ---- Policies ----

describe("GET and PUT /api/shops/[shop]/policies", () => {
  const get = (deps: FrontDeskDeps) => policiesGet(() => deps, request("GET", "/policies"), SHOP, OPTIONS);
  const put = (deps: FrontDeskDeps, init: RequestInit) =>
    policiesPut(() => deps, request("PUT", "/policies", init), SHOP, OPTIONS);

  it("returns the shop and its seeded policies", async () => {
    const body = await call<PoliciesResponse>(get(memoryDeps()));
    expect(body.shop).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
    expect(body.policies).toMatchObject({
      leadTimeMin: 120,
      horizonDays: 30,
      depositHorizonDays: 6,
      cancelWindowHours: 24,
      paused: false,
      phone: "+1 212-555-0142",
    });
  });

  it("merges a partial update, keeps the other fields, trims text, and saves it", async () => {
    const deps = memoryDeps();
    const before = (await call<PoliciesResponse>(get(deps))).policies;

    const body = await call<PoliciesResponse>(
      put(deps, { body: { paused: true, leadTimeMin: 60, phone: "  +1 212-555-0199  ", noShowRule: "  No-shows pay.  " } }),
    );
    const expected = { ...before, paused: true, leadTimeMin: 60, phone: "+1 212-555-0199", noShowRule: "No-shows pay." };
    expect(body).toEqual({ shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" }, policies: expected });
    expect(await deps.catalog.getPolicies(SHOP)).toEqual(expected);
    expect((await call<PoliciesResponse>(get(deps))).policies).toEqual(expected);
  });

  it("keeps both of two concurrent PUTs of different fields", async () => {
    const deps = memoryDeps();
    const before = (await call<PoliciesResponse>(get(deps))).policies;
    await Promise.all([
      call<PoliciesResponse>(put(deps, { body: { paused: true } })),
      call<PoliciesResponse>(put(deps, { body: { leadTimeMin: 60 } })),
    ]);
    expect((await call<PoliciesResponse>(get(deps))).policies).toEqual({ ...before, paused: true, leadTimeMin: 60 });
  });

  it("accepts phone null (removes it), an empty rule and the range limits", async () => {
    const deps = memoryDeps();
    const body = await call<PoliciesResponse>(
      put(deps, {
        body: { phone: null, depositRule: "", leadTimeMin: 0, horizonDays: 365, depositHorizonDays: 1, cancelWindowHours: 720 },
      }),
    );
    expect(body.policies).toMatchObject({
      phone: null,
      depositRule: "",
      leadTimeMin: 0,
      horizonDays: 365,
      depositHorizonDays: 1,
      cancelWindowHours: 720,
    });
  });

  it.each([
    ["leadTimeMin below 0", { leadTimeMin: -1 }, "leadTimeMin"],
    ["leadTimeMin above 7 days", { leadTimeMin: 10_081 }, "leadTimeMin"],
    ["leadTimeMin as a string", { leadTimeMin: "120" }, "leadTimeMin"],
    ["horizonDays 0", { horizonDays: 0 }, "horizonDays"],
    ["depositHorizonDays above 365", { depositHorizonDays: 366 }, "depositHorizonDays"],
    ["cancelWindowHours not whole", { cancelWindowHours: 1.5 }, "cancelWindowHours"],
    ["cancelWindowHours above 720", { cancelWindowHours: 721 }, "cancelWindowHours"],
    ["paused not a boolean", { paused: "yes" }, "paused"],
    ["phone of only spaces", { phone: "   " }, "phone"],
    ["phone too long", { phone: "1".repeat(41) }, "phone"],
    ["phone a number", { phone: 2125550142 }, "phone"],
    ["a rule too long", { lateCancelRule: "x".repeat(1001) }, "lateCancelRule"],
    ["a phone with a NUL character", { phone: "+1 212\u0000555-0142" }, "phone"],
    ["a phone of only a NUL character", { phone: "\u0000" }, "phone"],
    ["a depositRule with a NUL character", { depositRule: "Pay\u0000" }, "depositRule"],
    ["a lateCancelRule with a NUL character", { lateCancelRule: "\u0000" }, "lateCancelRule"],
    ["a noShowRule with a NUL character", { noShowRule: "No\u0000shows pay." }, "noShowRule"],
    ["an unknown field", { bogus: 1 }, "bogus"],
    ["an unknown field beside a valid one", { paused: true, timezone: "UTC" }, "timezone"],
    ["no fields", {}, "body"],
    ["an array", [], "body"],
    ["null", null, "body"],
  ])("rejects %s with 400 invalid_request and leaves the policies alone", async (name, payload, field) => {
    const deps = memoryDeps();
    const before = await deps.catalog.getPolicies(SHOP);
    const error = await invalid(put(deps, { body: payload }), field);
    if (field === "bogus") expect(error.message).toBe('Unknown field "bogus".');
    if (name === "a phone with a NUL character") expect(error.message).toBe("phone can't contain the NUL character (U+0000).");
    expect(await deps.catalog.getPolicies(SHOP)).toEqual(before);
  });

  it.each([
    ["an empty body", ""],
    ["a body that isn't JSON", "paused=true"],
    ["truncated JSON", '{"paused": tru'],
    ["a JSON string", '"paused"'],
  ])("rejects %s with 400 invalid_request (field body)", async (_name, raw) => {
    await invalid(put(memoryDeps(), { raw }), "body");
  });
});

// ---- Hours ----

describe("GET and PUT /api/shops/[shop]/hours", () => {
  const get = (deps: FrontDeskDeps) => hoursGet(() => deps, request("GET", "/hours"), SHOP, OPTIONS);
  const put = (deps: FrontDeskDeps, body: unknown) => hoursPut(() => deps, request("PUT", "/hours", { body }), SHOP, OPTIONS);

  it("returns every staff member's week, sorted by weekday then open", async () => {
    const body = await call<HoursResponse>(get(memoryDeps()));
    expect(body.shop.slug).toBe("harts");
    expect(body.staff).toHaveLength(1);
    const [dana] = body.staff;
    expect(dana.staffId).toBe("dana");
    expect(dana.staffName).toBe("Dana");
    expect(dana.weekly).toHaveLength(10);
    expect(dana.weekly.slice(0, 3)).toEqual([
      { weekday: 2, open: "09:00", close: "12:00" },
      { weekday: 2, open: "12:30", close: "17:00" },
      { weekday: 3, open: "09:00", close: "12:00" },
    ]);
  });

  it("replaces one staff member's whole week and returns everyone's, sorted", async () => {
    const deps = memoryDeps();
    const weekly: WeeklyHours[] = [
      { weekday: 6, open: "12:00", close: "16:00" },
      { weekday: 1, open: "10:15", close: "12:00" },
      { weekday: 6, open: "08:45", close: "12:00" }, // touches the 12:00 window: fine
    ];
    const body = await call<HoursResponse>(put(deps, { staffId: "dana", weekly }));
    const sorted = [weekly[1], weekly[2], weekly[0]];
    expect(body.staff).toEqual([{ staffId: "dana", staffName: "Dana", weekly: sorted }]);
    expect((await deps.catalog.getStaffHours(SHOP))[0].weekly).toEqual(sorted);
    expect((await call<HoursResponse>(get(deps))).staff[0].weekly).toEqual(sorted);
  });

  it("accepts an empty week (never works)", async () => {
    const body = await call<HoursResponse>(put(memoryDeps(), { staffId: "dana", weekly: [] }));
    expect(body.staff[0].weekly).toEqual([]);
  });

  const day = (open: string, close: string, weekday = 2) => ({ weekday, open, close });
  const fiftyOne = Array.from({ length: 51 }, (_, i) => ({
    weekday: (i % 7) + 1,
    open: `${String(Math.floor(i / 7)).padStart(2, "0")}:00`,
    close: `${String(Math.floor(i / 7)).padStart(2, "0")}:45`,
  }));

  it.each([
    ["a minute off the 15-minute grid", [day("09:10", "12:00")], "weekly.0.open"],
    ["a close off the grid", [day("09:00", "12:05")], "weekly.0.close"],
    ["a time that isn't HH:mm", [day("9:00", "12:00")], "weekly.0.open"],
    ["hour 24", [day("09:00", "24:00")], "weekly.0.close"],
    ["open equal to close", [day("12:00", "12:00")], "weekly.0.close"],
    ["open after close", [day("13:00", "12:00")], "weekly.0.close"],
    ["overlapping windows on one day", [day("09:00", "12:00"), day("13:00", "17:00"), day("11:45", "12:30")], "weekly.2"],
    ["weekday 0", [day("09:00", "12:00", 0)], "weekly.0.weekday"],
    ["weekday 8", [day("09:00", "12:00", 8)], "weekly.0.weekday"],
    ["an unknown field in a window", [{ ...day("09:00", "12:00"), staffId: "dana" }], "weekly.0.staffId"],
    ["more than 50 windows", fiftyOne, "weekly"],
  ])("rejects %s with 400 invalid_request", async (_name, weekly, field) => {
    const deps = memoryDeps();
    const before = await deps.catalog.getStaffHours(SHOP);
    const error = await invalid(put(deps, { staffId: "dana", weekly }), field);
    if (field === "weekly.2") expect(error.message).toBe("Two windows on Tuesday overlap: 09:00–12:00 and 11:45–12:30.");
    expect(await deps.catalog.getStaffHours(SHOP)).toEqual(before);
  });

  it.each([
    ["a missing staffId", { weekly: [] }, "staffId"],
    ["a missing weekly", { staffId: "dana" }, "weekly"],
    ["weekly not a list", { staffId: "dana", weekly: { weekday: 2 } }, "weekly"],
    ["an unknown top-level field", { staffId: "dana", weekly: [], shop: "harts" }, "shop"],
    ["a staffId with a NUL character", { staffId: "da\u0000na", weekly: [] }, "staffId"],
  ])("rejects %s with 400 invalid_request", async (_name, body, field) => {
    await invalid(put(memoryDeps(), body), field);
  });

  it("is 404 not_found with the valid staff ids for an unknown staff member", async () => {
    const error = await apiError(put(memoryDeps(), { staffId: "nobody", weekly: [] }), 404, "not_found");
    expect(error.details).toEqual({ staffId: "nobody", valid_staff_ids: ["dana"] });
  });
});

// ---- Blocks ----

describe("GET, POST and DELETE /api/shops/[shop]/blocks", () => {
  const get = (deps: FrontDeskDeps, query = "") => blocksGet(() => deps, request("GET", `/blocks${query}`), SHOP, OPTIONS);
  const post = (deps: FrontDeskDeps, body: unknown) =>
    blocksPost(() => deps, request("POST", "/blocks", { body }), SHOP, OPTIONS);
  const del = (deps: FrontDeskDeps, query: string) =>
    blocksDelete(() => deps, request("DELETE", `/blocks${query}`), SHOP, OPTIONS);

  const block = (start: string, end: string, reason = "") => ({ staffId: "dana", start: new Date(start), end: new Date(end), reason });

  it("lists blocks from 7 days ago to 366 days ahead by default, sorted by start", async () => {
    const deps = memoryDeps({
      initialBlocks: [
        block("2027-05-28T00:00:00-04:00", "2027-05-29T00:00:00-04:00", "Long weekend"),
        block("2026-11-06T00:00:00-05:00", "2026-11-07T00:00:00-05:00", "Training"),
        block("2026-10-30T00:00:00-04:00", "2026-10-31T00:00:00-04:00", "Too old"), // ends before 2 Nov noon
        block("2027-12-01T00:00:00-05:00", "2027-12-02T00:00:00-05:00", "Too far"), // after 10 Nov 2027
      ],
    });
    const body = await call<BlocksResponse>(get(deps));
    expect(body.shop.slug).toBe("harts");
    expect(body.blocks.map((b) => [b.start, b.end, b.reason])).toEqual([
      ["2026-11-06T00:00:00-05:00", "2026-11-07T00:00:00-05:00", "Training"],
      ["2027-05-28T00:00:00-04:00", "2027-05-29T00:00:00-04:00", "Long weekend"],
    ]);
  });

  it("lists blocks overlapping ?from=&to=", async () => {
    const deps = memoryDeps({
      initialBlocks: [
        block("2026-12-24T00:00:00-05:00", "2026-12-27T00:00:00-05:00", "Holiday"),
        block("2026-11-06T00:00:00-05:00", "2026-11-07T00:00:00-05:00", "Training"),
      ],
    });
    const query = `?from=${encodeURIComponent("2026-12-26T00:00:00-05:00")}&to=${encodeURIComponent("2027-01-01T00:00:00Z")}`;
    const body = await call<BlocksResponse>(get(deps, query));
    expect(body.blocks.map((b) => b.reason)).toEqual(["Holiday"]);
  });

  it.each([
    ["a from without an offset", `?from=2026-12-01T00:00:00`, "from"],
    ["a to that isn't a date", `?to=tomorrow`, "to"],
    ["from equal to to", `?from=${encodeURIComponent("2026-12-01T00:00:00Z")}&to=${encodeURIComponent("2026-12-01T00:00:00Z")}`, "to"],
    ["from after to", `?from=${encodeURIComponent("2026-12-02T00:00:00Z")}&to=${encodeURIComponent("2026-12-01T00:00:00Z")}`, "to"],
    ["a from in year 0000", `?from=${encodeURIComponent("0000-01-01T00:00:00Z")}`, "from"],
    ["a from in 1999", `?from=${encodeURIComponent("1999-12-31T23:59:59Z")}`, "from"],
    ["a to in 3000", `?to=${encodeURIComponent("3000-01-01T00:00:00Z")}`, "to"],
    ["a to in year 9999", `?to=${encodeURIComponent("9999-12-31T00:00:00Z")}`, "to"],
  ])("rejects %s with 400 invalid_request", async (_name, query, field) => {
    await invalid(get(memoryDeps(), query), field);
  });

  it("accepts ?from=&to= at the limits: 2000-01-01T00:00:00Z and 2999-12-31T23:59:59Z", async () => {
    const query = `?from=${encodeURIComponent("2000-01-01T00:00:00Z")}&to=${encodeURIComponent("2999-12-31T23:59:59Z")}`;
    expect((await call<BlocksResponse>(get(memoryDeps(), query))).blocks).toEqual([]);
  });

  it("creates a block (201), which then shows up in GET and as busy time of kind block", async () => {
    const deps = memoryDeps();
    const created = await call<BlockResponse>(
      post(deps, {
        staffId: "dana",
        start: "2026-12-24T05:00:00Z",
        end: "2026-12-27T00:00:00-05:00",
        reason: "  Holiday  ",
      }),
      201,
    );
    expect(created.block).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      staffId: "dana",
      start: "2026-12-24T00:00:00-05:00",
      end: "2026-12-27T00:00:00-05:00",
      reason: "Holiday",
    });

    expect((await call<BlocksResponse>(get(deps))).blocks).toEqual([created.block]);
    const busy = await deps.catalog.getBusyIntervals(SHOP, {
      start: new Date("2026-12-25T00:00:00-05:00"),
      end: new Date("2026-12-26T00:00:00-05:00"),
    });
    expect(busy).toEqual([
      expect.objectContaining({
        staffId: "dana",
        kind: "block",
        start: new Date("2026-12-24T00:00:00-05:00"),
        end: new Date("2026-12-27T00:00:00-05:00"),
      }),
    ]);
  });

  it('defaults the reason to ""', async () => {
    const created = await call<BlockResponse>(
      post(memoryDeps(), { staffId: "dana", start: "2026-12-24T00:00:00-05:00", end: "2026-12-25T00:00:00-05:00" }),
      201,
    );
    expect(created.block.reason).toBe("");
  });

  const valid = { staffId: "dana", start: "2026-12-24T00:00:00-05:00", end: "2026-12-25T00:00:00-05:00" };

  it.each([
    ["start equal to end", { ...valid, end: valid.start }, "end"],
    ["start after end", { ...valid, start: "2026-12-26T00:00:00-05:00" }, "end"],
    ["a start without an offset", { ...valid, start: "2026-12-24T00:00:00" }, "start"],
    ["an end that isn't a date", { ...valid, end: "Christmas" }, "end"],
    ["a block longer than 366 days", { ...valid, end: "2027-12-26T00:00:00-05:00" }, "end"],
    ["a reason over 200 characters", { ...valid, reason: "x".repeat(201) }, "reason"],
    ["a missing staffId", { start: valid.start, end: valid.end }, "staffId"],
    ["a missing start", { staffId: "dana", end: valid.end }, "start"],
    ["an unknown field", { ...valid, kind: "holiday" }, "kind"],
    ["a start in year 0000", { ...valid, start: "0000-12-24T00:00:00Z" }, "start"],
    ["a start in 1999", { ...valid, start: "1999-12-31T23:59:59Z" }, "start"],
    ["an end in 3000", { ...valid, end: "3000-01-01T00:00:00Z" }, "end"],
    ["a reason with a NUL character", { ...valid, reason: "Holi\u0000day" }, "reason"],
    ["a staffId with a NUL character", { ...valid, staffId: "dana\u0000" }, "staffId"],
  ])("rejects %s with 400 invalid_request and stores nothing", async (name, body, field) => {
    const deps = memoryDeps();
    const error = await invalid(post(deps, body), field);
    if (name === "an end in 3000") expect(error.message).toBe("end must be between 2000-01-01T00:00:00Z and 2999-12-31T23:59:59Z.");
    expect(await deps.catalog.listBlocks(SHOP, { start: new Date(0), end: new Date("3001-01-01T00:00:00Z") })).toEqual([]);
  });

  it("accepts blocks at the limits: from 2000-01-01T00:00:00Z, and up to 2999-12-31T23:59:59Z", async () => {
    const deps = memoryDeps();
    await call<BlockResponse>(post(deps, { ...valid, start: "2000-01-01T00:00:00Z", end: "2000-01-02T00:00:00Z" }), 201);
    await call<BlockResponse>(post(deps, { ...valid, start: "2999-12-31T00:00:00Z", end: "2999-12-31T23:59:59Z" }), 201);
  });

  it("accepts a block of exactly 366 days", async () => {
    await call<BlockResponse>(post(memoryDeps(), { ...valid, end: "2027-12-25T00:00:00-05:00" }), 201);
  });

  it("is 404 not_found for a staff member who isn't in the shop", async () => {
    const error = await apiError(post(memoryDeps(), { ...valid, staffId: "nobody" }), 404, "not_found");
    expect(error.details).toEqual({ staffId: "nobody", valid_staff_ids: ["dana"] });
  });

  it("deletes a block by ?id= and returns it; a second delete is 404", async () => {
    const deps = memoryDeps();
    const { block: created } = await call<BlockResponse>(post(deps, valid), 201);
    const deleted = await call<BlockResponse>(del(deps, `?id=${created.id}`));
    expect(deleted.block).toEqual(created);
    expect((await call<BlocksResponse>(get(deps))).blocks).toEqual([]);
    await apiError(del(deps, `?id=${created.id}`), 404, "not_found");
  });

  it.each([
    ["an unknown id", `?id=${RANDOM_UUID}`],
    ["a malformed id", "?id=not-a-uuid"],
  ])("is 404 not_found for %s", async (_name, query) => {
    const error = await apiError(del(memoryDeps(), query), 404, "not_found");
    expect(error.details).toHaveProperty("id");
  });

  it.each([
    ["no id", ""],
    ["an empty id", "?id="],
  ])("is 400 invalid_request (field id) for %s", async (_name, query) => {
    await invalid(del(memoryDeps(), query), "id");
  });
});

// ---- Services ----

describe("POST /api/shops/[shop]/services and PATCH /api/shops/[shop]/services/[id]", () => {
  const post = (deps: FrontDeskDeps, body: unknown) =>
    servicesPost(() => deps, request("POST", "/services", { body }), SHOP, OPTIONS);
  const patch = (deps: FrontDeskDeps, id: string, body: unknown) =>
    servicePatch(() => deps, request("PATCH", `/services/${id}`, { body }), SHOP, id, OPTIONS);

  const kidsCut = { id: "kids-cut", name: "Kids cut", durationMin: 20, priceCents: 2000, depositCents: 0 };

  it("creates a service (201) that appears at the end of the public list", async () => {
    const deps = memoryDeps();
    const body = await call<ServiceResponse>(post(deps, { ...kidsCut, name: "  Kids cut  " }), 201);
    expect(body).toEqual({ service: kidsCut });

    const listed = await call<ServicesResponse>(servicesResponse(() => deps, SHOP));
    expect(listed.services.map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard", "kids-cut"]);
    expect(listed.services.at(-1)).toEqual(kidsCut);
  });

  it("accepts a deposit equal to the price", async () => {
    await call<ServiceResponse>(post(memoryDeps(), { ...kidsCut, depositCents: 2000 }), 201);
  });

  it.each([
    ["a duplicate id", { ...kidsCut, id: "haircut" }, "id"],
    ["a deposit over the price", { ...kidsCut, depositCents: 2001 }, "depositCents"],
    ["an id with capitals", { ...kidsCut, id: "Kids-Cut" }, "id"],
    ["an id starting with a hyphen", { ...kidsCut, id: "-kids" }, "id"],
    ["an id over 40 characters", { ...kidsCut, id: "k".repeat(41) }, "id"],
    ["an empty name", { ...kidsCut, name: "   " }, "name"],
    ["a name over 80 characters", { ...kidsCut, name: "n".repeat(81) }, "name"],
    ["durationMin below 5", { ...kidsCut, durationMin: 4 }, "durationMin"],
    ["durationMin above 480", { ...kidsCut, durationMin: 481 }, "durationMin"],
    ["a negative price", { ...kidsCut, priceCents: -1 }, "priceCents"],
    ["a price over 1,000,000 cents", { ...kidsCut, priceCents: 1_000_001 }, "priceCents"],
    ["a price in dollars", { ...kidsCut, priceCents: 20.5 }, "priceCents"],
    ["a missing depositCents", { id: "kids-cut", name: "Kids cut", durationMin: 20, priceCents: 2000 }, "depositCents"],
    ["an unknown field", { ...kidsCut, position: 4 }, "position"],
    ["a name with a NUL character", { ...kidsCut, name: "Kids\u0000cut" }, "name"],
    ["an id with a NUL character", { ...kidsCut, id: "kids\u0000cut" }, "id"],
  ])("rejects %s with 400 invalid_request and adds nothing", async (name, body, field) => {
    const deps = memoryDeps();
    const error = await invalid(post(deps, body), field);
    if (name === "a duplicate id") expect(error.message).toBe('The shop already has a service with id "haircut".');
    if (name === "a deposit over the price") expect(error.message).toBe("depositCents (2001) can't be more than priceCents (2000).");
    expect((await deps.catalog.listServices(SHOP)).map((s) => s.id)).toEqual(["haircut", "beard-trim", "haircut-beard"]);
  });

  it("turns the store's deposit check into 400 invalid_request (field depositCents)", async () => {
    const deps = memoryDeps();
    const refusing: FrontDeskDeps = {
      ...deps,
      catalog: {
        ...deps.catalog,
        createService: async (_slug, service) => {
          throw new DepositExceedsPriceError(service.id);
        },
      },
    };
    const error = await invalid(post(refusing, kidsCut), "depositCents");
    expect(error.message).toBe("The deposit can't be more than the price.");
  });

  it("changes some fields of a service and keeps the rest", async () => {
    const deps = memoryDeps();
    const body = await call<ServiceResponse>(patch(deps, "haircut", { priceCents: 4000, name: " Classic haircut " }));
    const expected = { id: "haircut", name: "Classic haircut", durationMin: 30, priceCents: 4000, depositCents: 1000 };
    expect(body).toEqual({ service: expected });
    expect((await deps.catalog.listServices(SHOP))[0]).toEqual(expected);
  });

  it("checks depositCents <= priceCents on the merged values", async () => {
    const deps = memoryDeps();
    // haircut: price 3500, deposit 1000.
    const lowPrice = await invalid(patch(deps, "haircut", { priceCents: 500 }), "priceCents");
    expect(lowPrice.message).toBe("depositCents (1000) can't be more than priceCents (500).");
    await invalid(patch(deps, "haircut", { depositCents: 3501 }), "depositCents");
    // Both together is fine when the result is consistent.
    await call<ServiceResponse>(patch(deps, "haircut", { priceCents: 500, depositCents: 500 }));
  });

  it("never stores a deposit over the price when two PATCHes race: one 200, one 400 naming the field it sent", async () => {
    const deps = memoryDeps();
    // haircut: price 3500, deposit 1000. Each change passes the pre-check alone; together the deposit
    // would be over the price, and the store refuses whichever applies second.
    const bodies = [{ depositCents: 3000 }, { priceCents: 2000 }];
    const responses = await Promise.all(bodies.map((b) => patch(deps, "haircut", b)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const loser = responses.findIndex((r) => r.status === 400);
    await invalid(Promise.resolve(responses[loser]), Object.keys(bodies[loser])[0]);
    const stored = (await deps.catalog.listServices(SHOP)).find((s) => s.id === "haircut")!;
    expect(stored.depositCents).toBeLessThanOrEqual(stored.priceCents);
  });

  it("leaves existing bookings' deposit snapshot alone", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, FUTURE);
    await call<ServiceResponse>(patch(deps, "haircut", { depositCents: 0 }));
    const body = await call<BookingDetailResponse>(detail(deps, booking.id));
    expect(body.booking.depositCents).toBe(1000);
  });

  it("is 404 not_found with the valid ids for an unknown service", async () => {
    const error = await apiError(patch(memoryDeps(), "perm", { priceCents: 4000 }), 404, "not_found");
    expect(error.details).toEqual({ service_id: "perm", valid_service_ids: ["haircut", "beard-trim", "haircut-beard"] });
  });

  it("is 404 not_found for a service id containing NUL, without writing", async () => {
    const deps = memoryDeps();
    const updateService = vi.spyOn(deps.catalog, "updateService");
    const error = await apiError(patch(deps, "hair\u0000cut", { priceCents: 4000 }), 404, "not_found");
    expect(error.details).toMatchObject({ service_id: "hair\u0000cut" });
    expect(updateService).not.toHaveBeenCalled();
  });

  it.each([
    ["no fields", {}, "body"],
    ["the id", { id: "new-id" }, "id"],
    ["a durationMin out of range", { durationMin: 2 }, "durationMin"],
    ["an empty name", { name: "" }, "name"],
    ["a name with a NUL character", { name: "Hair\u0000cut" }, "name"],
  ])("rejects a patch with %s", async (_name, body, field) => {
    await invalid(patch(memoryDeps(), "haircut", body), field);
  });
});

// ---- Booking detail and actions ----

describe("GET /api/shops/[shop]/bookings/[id]", () => {
  it("returns a hold awaiting approval, unverified, with its booked event", async () => {
    const deps = memoryDeps();
    const { booking } = await createHold(deps, FUTURE);
    const body = await call<BookingDetailResponse>(detail(deps, booking.id));
    expect(body.booking).toEqual(booking);
    expect(body.booking).toMatchObject({ status: "awaiting_approval", customer: { displayName: "Pat Owner-Test", verified: false } });
    expect(body.booking).not.toHaveProperty("approval");
    expect(body.events).toEqual([
      {
        id: expect.any(String),
        bookingId: booking.id,
        at: "2026-11-09T12:00:00-05:00",
        actor: "agent",
        type: "booked",
        data: { status: "awaiting_approval", agentName: "test agent" },
      },
    ]);
  });

  it("shows the verified customer once the person approved", async () => {
    const deps = memoryDeps();
    const { booking, token } = await createHold(deps, FUTURE);
    await approve(deps, token, "+14015550123");
    const body = await call<BookingDetailResponse>(detail(deps, booking.id));
    expect(body.booking).toEqual({
      ...booking,
      status: "confirmed",
      customer: { displayName: "Pat Owner-Test", verified: true, phoneLast4: "0123" },
    });
    expect(body.events.map((e) => [e.type, e.actor, e.data])).toEqual([
      ["booked", "agent", { status: "awaiting_approval", agentName: "test agent" }],
      [
        "approved",
        "customer",
        { from: "awaiting_approval", to: "confirmed", depositEffect: "none", depositCollected: false, phoneLast4: "0123" },
      ],
    ]);
  });

  it("expires a hold that ran out when it's read, with one expired event", async () => {
    const clock = movableClock();
    const deps = memoryDeps({ clock });
    const { booking } = await createHold(deps, FUTURE);
    clock.advance(10 * 60_000);
    const body = await call<BookingDetailResponse>(detail(deps, booking.id));
    expect(body.booking.status).toBe("expired");
    await call<BookingDetailResponse>(detail(deps, booking.id));
    expect((await call<BookingDetailResponse>(detail(deps, booking.id))).events.map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
  });

  it("lists each transition after booked, oldest first", async () => {
    const deps = memoryDeps();
    const cancelled = await createBooking(deps, FUTURE);
    const completed = await createBooking(deps, PAST);
    const noShow = await createBooking(deps, YESTERDAY);
    await call(act(deps, cancelled.id, "cancel"));
    await call(act(deps, completed.id, "complete"));
    await call(act(deps, noShow.id, "mark_no_show"));

    const history = async (id: string) => (await call<BookingDetailResponse>(detail(deps, id))).events;
    const afterApproval = async (id: string) => (await history(id)).slice(2).map((e) => [e.type, e.actor, e.data]);
    for (const id of [cancelled.id, completed.id, noShow.id]) {
      expect((await history(id)).slice(0, 2).map((e) => [e.type, e.actor])).toEqual(BOOKED_THEN_APPROVED);
    }
    expect(await afterApproval(cancelled.id)).toEqual([
      ["cancelled", "owner", { from: "confirmed", to: "cancelled", depositEffect: "released", depositCollected: false }],
    ]);
    expect(await afterApproval(completed.id)).toEqual([
      ["completed", "owner", { from: "confirmed", to: "completed", depositEffect: "released", depositCollected: false }],
    ]);
    expect(await afterApproval(noShow.id)).toEqual([
      ["no_show", "owner", { from: "confirmed", to: "no_show", depositEffect: "captured", depositCollected: false }],
    ]);
  });

  it("is 404 booking_not_found for a random UUID, a malformed id and another shop's booking", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, FUTURE);
    await apiError(detail(deps, RANDOM_UUID), 404, "booking_not_found");
    await apiError(detail(deps, "not-a-uuid"), 404, "booking_not_found");
    await apiError(detail(deps, `${booking.id}\u0000`), 404, "booking_not_found");
    await apiError(act(deps, `${booking.id}\u0000`, "cancel"), 404, "booking_not_found");

    // A second shop that exists but doesn't own the booking.
    const other = { slug: "other", name: "Other Shop", timezone: "America/New_York" };
    const twoShops: FrontDeskDeps = {
      ...deps,
      catalog: {
        ...deps.catalog,
        getShop: async (slug) => (slug === other.slug ? { ...other } : deps.catalog.getShop(slug)),
      },
    };
    const error = await apiError(detail(twoShops, booking.id, "other"), 404, "booking_not_found");
    expect(error.details).toEqual({ booking_id: booking.id });
    await apiError(act(twoShops, booking.id, "cancel", "other"), 404, "booking_not_found");
    expect((await deps.store.getBooking(booking.id))?.status).toBe("confirmed");
  });

  it("is 404 not_found for an unknown shop", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, FUTURE);
    await apiError(detail(deps, booking.id, "nope"), 404, "not_found");
  });
});

describe("POST /api/shops/[shop]/bookings/[id]/cancel, /complete and /no-show (owner)", () => {
  it("cancels before the start: cancelled, deposit released, nothing collected", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, FUTURE);
    const body = await call<OwnerBookingActionResponse>(act(deps, booking.id, "cancel"));
    expect(body).toEqual({
      booking: { ...booking, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    });
  });

  it('reports depositEffect "none" for a booking without a deposit', async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, FUTURE, { serviceId: "beard-trim", minutes: 15, depositCents: 0 });
    const body = await call<OwnerBookingActionResponse>(act(deps, booking.id, "cancel"));
    expect(body.depositEffect).toBe("none");
  });

  it("can't cancel after the start (400 invalid_request)", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, PAST);
    const error = await apiError(act(deps, booking.id, "cancel"), 400, "invalid_request");
    expect(error.details).toMatchObject({ status: "confirmed", action: "cancel" });
    expect((await deps.store.getBooking(booking.id))?.status).toBe("confirmed");
  });

  it.each(["complete", "mark_no_show"] as const)("can't %s before the start (400 invalid_request)", async (action) => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, FUTURE);
    await apiError(act(deps, booking.id, action), 400, "invalid_request");
    expect((await deps.store.getBooking(booking.id))?.status).toBe("confirmed");
    expect(await deps.store.listEvents(booking.id)).toHaveLength(2);
  });

  it('marks a past booking no_show: deposit "captured", not collected; the detail shows both events', async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, YESTERDAY);
    const body = await call<OwnerBookingActionResponse>(act(deps, booking.id, "mark_no_show"));
    expect(body.booking.status).toBe("no_show");
    expect(body.depositEffect).toBe("captured");
    expect(body.depositCollected).toBe(false);

    const history = await call<BookingDetailResponse>(detail(deps, booking.id));
    expect(history.booking.status).toBe("no_show");
    expect(history.events.map((e) => [e.type, e.actor])).toEqual([...BOOKED_THEN_APPROVED, ["no_show", "owner"]]);
  });

  it("marks a started booking completed: deposit released", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, PAST);
    const body = await call<OwnerBookingActionResponse>(act(deps, booking.id, "complete"));
    expect(body).toEqual({ booking: { ...booking, status: "completed" }, depositEffect: "released", depositCollected: false });
  });

  it.each(["cancel", "complete", "mark_no_show"] as const)("can't %s a final booking (400 invalid_request)", async (action) => {
    const deps = memoryDeps();
    const noShow = await createBooking(deps, YESTERDAY);
    await call(act(deps, noShow.id, "mark_no_show"));
    const error = await apiError(act(deps, noShow.id, action), 400, "invalid_request");
    expect(error.details).toMatchObject({ status: "no_show", action });
    expect(await deps.store.listEvents(noShow.id)).toHaveLength(3);

    // A booking preloaded as cancelled, in the future (so the start isn't what blocks it).
    const preloaded = memoryDeps({
      initialBookings: [
        {
          shopSlug: SHOP,
          serviceId: "haircut",
          staffId: "dana",
          start: new Date(FUTURE),
          end: new Date("2026-11-14T10:30:00-05:00"),
          customerName: "Pat Owner-Test",
          agentName: "test agent",
          status: "cancelled",
        },
      ],
    });
    const [cancelled] = await preloaded.store.listBookings(SHOP, {
      start: new Date("2026-11-14T00:00:00-05:00"),
      end: new Date("2026-11-15T00:00:00-05:00"),
    });
    await apiError(act(preloaded, cancelled.id, action), 400, "invalid_request");
  });

  it("cancels a hold awaiting approval any time, even after its start: released, and the approval link is closed", async () => {
    const deps = memoryDeps();
    const future = await createHold(deps, FUTURE);
    const started = await createHold(deps, PAST);
    const body = await call<OwnerBookingActionResponse>(act(deps, future.booking.id, "cancel"));
    expect(body).toEqual({ booking: { ...future.booking, status: "cancelled" }, depositEffect: "released", depositCollected: false });
    expect((await call<OwnerBookingActionResponse>(act(deps, started.booking.id, "cancel"))).booking.status).toBe("cancelled");
    expect((await deps.store.listEvents(future.booking.id)).map((e) => [e.type, e.actor])).toEqual([
      ["booked", "agent"],
      ["cancelled", "owner"],
    ]);
    // The person can no longer approve it.
    await expect(approveBooking(deps, future.token, { phone: nextPhone() })).rejects.toMatchObject({ code: "approval_closed" });
  });

  it.each(["complete", "mark_no_show"] as const)("can't %s a hold awaiting approval (400 invalid_request)", async (action) => {
    const deps = memoryDeps();
    const { booking } = await createHold(deps, PAST);
    const error = await apiError(act(deps, booking.id, action), 400, "invalid_request");
    expect(error.details).toMatchObject({ status: "awaiting_approval", action });
    expect(error.message).toMatch(/awaiting approval/);
    expect((await deps.store.getBooking(booking.id))?.status).toBe("awaiting_approval");
    expect(await deps.store.listEvents(booking.id)).toHaveLength(1);
  });

  it("can't cancel a hold that ran out: it reads as expired (400 invalid_request)", async () => {
    const clock = movableClock();
    const deps = memoryDeps({ clock });
    const { booking } = await createHold(deps, FUTURE);
    clock.advance(10 * 60_000);
    const error = await apiError(act(deps, booking.id, "cancel"), 400, "invalid_request");
    expect(error.details).toMatchObject({ status: "expired", action: "cancel" });
  });

  it.each(["cancel", "complete", "mark_no_show"] as const)("%s: 404 booking_not_found for an unknown id", async (action) => {
    await apiError(act(memoryDeps(), RANDOM_UUID, action), 404, "booking_not_found");
  });

  it("lets exactly one of a concurrent complete and no-show win, with one transition event", async () => {
    const deps = memoryDeps();
    const booking = await createBooking(deps, PAST);
    const responses = await Promise.all([act(deps, booking.id, "complete"), act(deps, booking.id, "mark_no_show")]);
    const statuses = responses.map((r) => r.status);
    expect([...statuses].sort()).toEqual([200, 400]);

    const winner = (await responses[statuses.indexOf(200)].json()) as OwnerBookingActionResponse;
    const loser = (await responses[statuses.indexOf(400)].json()) as ApiError;
    expect(loser.error.code).toBe("invalid_request");
    expect(loser.error.details).toMatchObject({ status: winner.booking.status });

    const events = await deps.store.listEvents(booking.id);
    expect(events.filter((e) => e.type !== "booked" && e.type !== "approved")).toHaveLength(1);
    expect((await deps.store.getBooking(booking.id))?.status).toBe(winner.booking.status);
  });
});

describe("GET /api/shops/[shop]/bookings (the owner's list)", () => {
  it("shows holds awaiting approval, verified customers with their phone's last 4 digits, and expires lapsed holds", async () => {
    const clock = movableClock();
    const deps = memoryDeps({ clock });
    const lapsing = await createHold(deps, "2026-11-14T09:00:00-05:00");
    clock.advance(5 * 60_000);
    const live = await createHold(deps, FUTURE);
    const confirmed = await createHold(deps, "2026-11-14T11:00:00-05:00");
    await approve(deps, confirmed.token, "+14015550123");
    clock.advance(5 * 60_000); // the first hold's deadline; the second still has 5 minutes

    const body = await call<BookingsResponse>(bookingsResponse(() => deps, SHOP));
    expect(body.bookings.map((b) => [b.id, b.status, b.customer])).toEqual([
      [lapsing.booking.id, "expired", { displayName: "Pat Owner-Test", verified: false }],
      [live.booking.id, "awaiting_approval", { displayName: "Pat Owner-Test", verified: false }],
      [confirmed.booking.id, "confirmed", { displayName: "Pat Owner-Test", verified: true, phoneLast4: "0123" }],
    ]);
    expect(body.bookings.every((b) => !("approval" in b))).toBe(true);
    expect((await deps.store.listEvents(lapsing.booking.id)).map((e) => e.type)).toEqual(["booked", "expired"]);
  });
});
