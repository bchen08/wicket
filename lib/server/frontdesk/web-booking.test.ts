import { describe, expect, it } from "vitest";
import type {
  ApiError,
  ApprovalView,
  BookingPageResponse,
  FrontDeskDiscovery,
  GetAvailabilityResult,
  Slot,
  WebAvailabilityResponse,
  WebBookResponse,
} from "../../types/frontdesk";
import { fixedClock } from "../clock";
import { approvalGet } from "../consent/http";
import { FrontDeskError } from "./errors";
import { createFrontDeskMcpHandler } from "./mcp";
import { getAvailability, type FrontDeskDeps } from "./service";
import { EXAMPLE_BOOKINGS, memoryDeps, SAT, withCatalog } from "./test-support";
import { forWeb, webAgentName } from "./web-booking";
import { agentsMdGet, availabilityGet, bookingPageGet, bookPost, discoveryGet } from "./web-http";

// The web booking API (plain HTTP, no MCP) through its HTTP handlers, the ones the route files call.
// "Now" is Mon 9 Nov 2026, noon in New York (Hart's is closed Mondays); Saturday 14 Nov is 5 days ahead.
// Hart's has one staff member, Dana, Tue–Sat 9:00–12:00 and 12:30–17:00. Haircut takes a $10 deposit, so
// it can be booked 6 days ahead (until Sun 15 Nov, noon); a beard trim 30 days ahead.

/** The origin the requests come from: approval links and URLs must use it. */
const ORIGIN = "https://emergent-git-claude-31-web-booking.vercel.app";
const SAT_1430 = "2026-11-14T14:30:00-05:00";

type Fixture = { deps: FrontDeskDeps; getDeps: () => FrontDeskDeps };
function fixture(options: Parameters<typeof memoryDeps>[0] = {}): Fixture {
  const deps = memoryDeps({ initialBookings: EXAMPLE_BOOKINGS, ...options });
  return { deps, getDeps: () => deps };
}

const get = (path: string) => new Request(`${ORIGIN}${path}`);

async function availability(f: Fixture, query: string, shop = "harts") {
  const res = await availabilityGet(f.getDeps, get(`/api/shops/${shop}/availability${query}`), shop);
  return { res, body: (await res.json()) as WebAvailabilityResponse & ApiError };
}

/** Every slot the MCP get_availability tool returns for [from, to), paging with limit 50 as its docs say. */
async function mcpSlots(deps: FrontDeskDeps, serviceId: string, from: string, to: string): Promise<Slot[]> {
  const handler = createFrontDeskMcpHandler(() => deps);
  const slots: Slot[] = [];
  let cursor = from;
  for (let id = 1; ; id++) {
    const res = await handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "get_availability", arguments: { service_id: serviceId, from: cursor, to, limit: 50 } },
        }),
      }),
    );
    const text = await res.text();
    const json = text.trimStart().startsWith("{")
      ? text
      : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    const result = JSON.parse(json).result as { structuredContent?: GetAvailabilityResult; isError?: boolean; content: { text: string }[] };
    if (result.isError) throw new Error(result.content[0].text);
    const page = result.structuredContent!;
    slots.push(...page.slots);
    if (!page.truncated) return slots;
    // One staff member, so one slot per start: continue one minute after the last start.
    const last = new Date(Date.parse(page.slots.at(-1)!.start) + 60_000);
    cursor = last.toISOString();
  }
}

const flat = (body: WebAvailabilityResponse) => body.days.flatMap((d) => d.slots);

describe("GET /api/shops/[shop]/availability", () => {
  it("one day: exactly the slots the MCP get_availability tool returns for that day", async () => {
    const f = fixture();
    const { res, body } = await availability(f, "?service=haircut&from=2026-11-14&days=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ from: "2026-11-14", to: "2026-11-15", paused: false, phone: "+1 212-555-0142" });
    expect(body.shop.slug).toBe("harts");
    expect(body.service).toEqual({ id: "haircut", name: "Haircut", durationMin: 30, priceCents: 3500, depositCents: 1000 });
    expect(body.days.map((d) => [d.date, d.display])).toEqual([["2026-11-14", "Sat 14 Nov"]]);

    const mcp = await mcpSlots(f.deps, "haircut", SAT.from, SAT.to);
    expect(body.days[0].slots).toEqual(mcp);
    // Lunch and the example bookings (10:00–10:45, 15:00–15:30) are skipped; every slot has a display.
    expect(mcp.length).toBeGreaterThan(20);
    expect(body.days[0].slots[0]).toEqual({
      start: "2026-11-14T09:00:00-05:00",
      end: "2026-11-14T09:30:00-05:00",
      staffId: "dana",
      display: "Sat 14 Nov, 9:00 am EST",
    });
  });

  it("defaults to today and 7 days in the shop's zone; the days together match MCP over the same window", async () => {
    const f = fixture();
    const { res, body } = await availability(f, "?service=haircut");
    expect(res.status).toBe(200);
    expect(body.from).toBe("2026-11-09");
    expect(body.to).toBe("2026-11-16");
    expect(body.days.map((d) => d.date)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(body.days.map((d) => d.display)).toEqual(["Mon 9 Nov", "Tue 10 Nov", "Wed 11 Nov", "Thu 12 Nov", "Fri 13 Nov", "Sat 14 Nov", "Sun 15 Nov"]);
    // Closed Monday and Sunday; Tue–Sat open. Each day's slots fall on that local date.
    expect(body.days.map((d) => d.slots.length > 0)).toEqual([false, true, true, true, true, true, false]);
    for (const day of body.days) for (const slot of day.slots) expect(slot.start.slice(0, 10)).toBe(day.date);

    const mcp = await mcpSlots(f.deps, "haircut", "2026-11-09T00:00:00-05:00", "2026-11-16T00:00:00-05:00");
    expect(mcp.length).toBeGreaterThan(50); // more than one MCP page
    expect(flat(body)).toEqual(mcp);
  });

  it("days=14 across the November clock change works, day by day (one 14-day MCP window would be 337 hours)", async () => {
    // Thu 28 Oct 2027; clocks go back on Sun 7 Nov 2027.
    const f = fixture({ clock: fixedClock(new Date("2027-10-28T08:00:00-04:00")), initialBookings: [] });
    const { res, body } = await availability(f, "?service=beard-trim&from=2027-10-28&days=14");
    expect(res.status).toBe(200);
    expect(body.days).toHaveLength(14);
    expect(body.to).toBe("2027-11-11");
    expect(body.days[0].slots[0].display).toBe("Thu 28 Oct, 10:00 am EDT"); // 2 hours' notice
    expect(body.days.at(-1)!.slots[0].display).toBe("Wed 10 Nov, 9:00 am EST");

    const halves = [
      ...(await mcpSlots(f.deps, "beard-trim", "2027-10-28T00:00:00-04:00", "2027-11-04T00:00:00-04:00")),
      ...(await mcpSlots(f.deps, "beard-trim", "2027-11-04T00:00:00-04:00", "2027-11-11T00:00:00-05:00")),
    ];
    expect(flat(body)).toEqual(halves);
  });

  it("returns every staff member's slot at each start, even when a day needs more than one page", async () => {
    // Two staff members with Dana's hours: each start has two slots, 56 on a Saturday (pages of 50).
    const base = fixture({ initialBookings: [] });
    const deps = withCatalog(base.deps, (catalog) => ({
      async getStaffHours(slug) {
        const [dana] = await catalog.getStaffHours(slug);
        return [dana, { ...dana, staffId: "eli", staffName: "Eli" }];
      },
    }));
    const { body } = await availability({ deps, getDeps: () => deps }, "?service=haircut&from=2026-11-14&days=1");
    const slots = body.days[0].slots;
    expect(slots).toHaveLength(56);
    const starts = [...new Set(slots.map((s) => s.start))];
    expect(starts).toHaveLength(28);
    for (const start of starts) {
      expect(slots.filter((s) => s.start === start).map((s) => s.staffId).sort()).toEqual(["dana", "eli"]);
    }
    // The same as one getAvailability call over the day with no limit to hit (two halves of 28 each).
    const am = await getAvailability(deps, "harts", { service_id: "haircut", from: SAT.from, to: "2026-11-14T12:00:00-05:00", limit: 50 });
    const pm = await getAvailability(deps, "harts", { service_id: "haircut", from: "2026-11-14T12:00:00-05:00", to: SAT.to, limit: 50 });
    expect(slots).toEqual([...am.slots, ...pm.slots]);
  });

  it("paused: every day is empty, paused is true and phone says whom to call", async () => {
    const { res, body } = await availability(fixture({ policies: { paused: true } }), "?service=haircut&from=2026-11-14&days=2");
    expect(res.status).toBe(200);
    expect(body.paused).toBe(true);
    expect(body.phone).toBe("+1 212-555-0142");
    expect(body.days.map((d) => d.slots)).toEqual([[], []]);
  });

  it("refuses a missing service, a bad from or days, with invalid_request and the web field name", async () => {
    const f = fixture();
    const cases: [string, string][] = [
      ["", "service"],
      ["?service=", "service"],
      ["?service=haircut&from=14-11-2026", "from"],
      ["?service=haircut&from=2026-02-30", "from"],
      ["?service=haircut&from=2026-11-14T00:00:00-05:00", "from"],
      ["?service=haircut&from=9999-01-01", "from"],
      ["?service=haircut&days=0", "days"],
      ["?service=haircut&days=15", "days"],
      ["?service=haircut&days=2.5", "days"],
      ["?service=haircut&days=seven", "days"],
    ];
    for (const [query, field] of cases) {
      const { res, body } = await availability(f, query);
      expect(res.status, query).toBe(400);
      expect(body.error.code, query).toBe("invalid_request");
      expect(body.error.details?.field, query).toBe(field);
      expect(body.error.next_action, query).not.toMatch(/get_availability|list_services/);
    }
  });

  it("an unknown service is 404 with the valid ids; an unknown shop is 404", async () => {
    const f = fixture();
    const unknown = await availability(f, "?service=perm");
    expect(unknown.res.status).toBe(404);
    expect(unknown.body.error).toMatchObject({
      code: "not_found",
      details: { service: "perm", valid_service_ids: ["haircut", "beard-trim", "haircut-beard"] },
    });
    const shop = await availability(f, "?service=haircut", "nope");
    expect(shop.res.status).toBe(404);
    expect(shop.body.error.code).toBe("not_found");
  });
});

// ---- Booking ----

/** A JSON POST to the book route. */
function bookJson(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/shops/harts/book`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A plain HTML form post to the book route, from the page at `referer` (none when null). */
function bookForm(fields: Record<string, string>, referer: string | null = `${ORIGIN}/book/harts`, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/shops/harts/book`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(referer ? { referer } : {}), ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function postJson(f: Fixture, body: unknown, headers?: Record<string, string>) {
  const res = await bookPost(f.getDeps, bookJson(body, headers), "harts");
  return { res, body: (await res.json()) as WebBookResponse & ApiError };
}

/** The approval page's view for a link, through the approval API. */
async function viewOf(f: Fixture, link: string): Promise<ApprovalView> {
  const token = link.slice(link.lastIndexOf("/") + 1);
  return (await (await approvalGet(f.getDeps, token)).json()) as ApprovalView;
}

describe("POST /api/shops/[shop]/book with JSON", () => {
  it("201: the hold with its approval link on the request's origin, a statusUrl and next_action", async () => {
    const f = fixture();
    const { res, body } = await postJson(f, { service: "haircut", start: SAT_1430, name: "Maya", bookedBy: "Maya's assistant" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { booking } = body;
    expect(booking).toMatchObject({
      serviceId: "haircut",
      start: SAT_1430,
      display: "Sat 14 Nov, 2:30 pm EST",
      status: "awaiting_approval",
      customer: { displayName: "Maya", approved: false },
      agent: { name: "Maya's assistant" },
      depositCents: 1000,
    });
    expect(booking.approval?.url).toMatch(new RegExp(`^${ORIGIN}/approve/[A-Za-z0-9_-]{43}$`));
    const token = booking.approval!.url.split("/approve/")[1];
    expect(body.statusUrl).toBe(`${ORIGIN}/api/approvals/${token}`);
    expect(body.next_action).toContain(booking.approval!.url);
    expect(body.next_action).toContain(body.statusUrl);
    expect(body.next_action).toContain("Mon 9 Nov, 12:10 pm EST"); // the hold lapses 10 minutes from now

    // The same engine: the person's approval page shows it, and MCP stops offering 2:15–2:45.
    const view = await viewOf(f, booking.approval!.url);
    expect(view).toMatchObject({ status: "pending", customerName: "Maya", agentName: "Maya's assistant", display: "Sat 14 Nov, 2:30 pm EST" });
    const starts = (await mcpSlots(f.deps, "haircut", SAT.from, SAT.to)).map((s) => s.start);
    expect(starts).not.toContain(SAT_1430);
    expect(starts).not.toContain("2026-11-14T14:15:00-05:00");
  });

  it("without bookedBy the agent is web plus the User-Agent's first 60 characters (or just web)", async () => {
    const f = fixture();
    const curl = await postJson(f, { service: "beard-trim", start: "2026-11-14T09:00:00-05:00", name: "Lee" }, { "user-agent": "curl/8.7.1" });
    expect(curl.body.booking.agent.name).toBe("web (curl/8.7.1)");
    const blank = await postJson(f, { service: "beard-trim", start: "2026-11-14T09:15:00-05:00", name: "Lee", bookedBy: "  " });
    expect(blank.body.booking.agent.name).toBe("web");

    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
    expect(webAgentName(undefined, ua)).toBe(`web (${ua.slice(0, 60).trim()})`);
    expect(webAgentName(undefined, null)).toBe("web");
    expect(webAgentName("Claude", ua)).toBe("Claude");
  });

  it("slot_taken: 409 with alternatives, worded for the web API", async () => {
    const f = fixture();
    await postJson(f, { service: "haircut", start: SAT_1430, name: "Maya" });
    const { res, body } = await postJson(f, { service: "haircut", start: SAT_1430, name: "Jo" });
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("slot_taken");
    expect(body.error.message).toBe("That time is already booked.");
    expect(body.error.next_action).toBe(
      "Someone just took that time. Call GET /api/shops/harts/availability again and choose another start. " +
        "Nearby open starts you can offer instead are in details.alternatives.",
    );
    // The closest free starts: 2:00 and 1:45; then 1:30 and 3:30 tie at an hour away (3:00 is the example
    // booking), and the earlier one wins.
    expect((body.error.details?.alternatives as Slot[]).map((s) => s.display)).toEqual([
      "Sat 14 Nov, 1:30 pm EST",
      "Sat 14 Nov, 1:45 pm EST",
      "Sat 14 Nov, 2:00 pm EST",
    ]);
  });

  it("outside_hours: 422 for lunch or an off-grid start, pointing at the availability route", async () => {
    const f = fixture();
    for (const start of ["2026-11-14T12:00:00-05:00", "2026-11-14T14:20:00-05:00"]) {
      const { res, body } = await postJson(f, { service: "haircut", start, name: "Maya" });
      expect(res.status, start).toBe(422);
      expect(body.error).toEqual({
        code: "outside_hours",
        message: "That isn't a bookable time for Haircut.",
        next_action: "Call GET /api/shops/harts/availability and choose one of the returned starts.",
        details: { field: "start", value: start, service_id: "haircut" },
      });
    }
  });

  it("the rest of book's rules, with the same codes: too_soon, too_far, paused, outside_mandate", async () => {
    const f = fixture();
    const tooSoon = await postJson(f, { service: "haircut", start: "2026-11-09T12:30:00-05:00", name: "Maya" });
    expect([tooSoon.res.status, tooSoon.body.error.code]).toEqual([422, "too_soon"]);
    expect(tooSoon.body.error.next_action).toBe(
      "Pick a later time: call GET /api/shops/harts/availability with from set to the date of details.earliest.",
    );
    const tooFar = await postJson(f, { service: "haircut", start: "2026-11-17T10:00:00-05:00", name: "Maya" });
    expect([tooFar.res.status, tooFar.body.error.code]).toEqual([422, "too_far"]);
    const mandate = await postJson(f, { service: "haircut", start: SAT_1430, name: "Maya", mandate: { priceCapCents: 3000 } });
    expect([mandate.res.status, mandate.body.error.code, mandate.body.error.details?.field]).toEqual([422, "outside_mandate", "price_cap"]);
    const paused = await postJson(fixture({ policies: { paused: true } }), { service: "haircut", start: SAT_1430, name: "Maya" });
    expect([paused.res.status, paused.body.error.code]).toEqual([409, "paused"]);
  });

  it("invalid_request names the web field (service, start, name, bookedBy, body), never the MCP one", async () => {
    const f = fixture();
    const cases: [unknown, string][] = [
      [{ start: SAT_1430, name: "Maya" }, "service"],
      [{ service: "perm", start: SAT_1430, name: "Maya" }, "service"],
      [{ service: "haircut", name: "Maya" }, "start"],
      [{ service: "haircut", start: "Saturday 2:30", name: "Maya" }, "start"],
      [{ service: "haircut", start: SAT_1430 }, "name"],
      [{ service: "haircut", start: SAT_1430, name: "x".repeat(81) }, "name"],
      [{ service: "haircut", start: SAT_1430, name: "Ma\u0000ya" }, "name"],
      [{ service: "haircut", start: SAT_1430, name: "Maya", bookedBy: 7 }, "bookedBy"],
      [{ service: "haircut", start: SAT_1430, name: "Maya", mandate: { cap: 1 } }, "mandate.cap"],
      [[{ service: "haircut" }], "body"],
      ["not json", "body"],
      ["", "body"],
    ];
    for (const [body, field] of cases) {
      const res = await postJson(f, body);
      const label = JSON.stringify(body);
      expect(res.res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe("invalid_request");
      expect(res.body.error.details?.field, label).toBe(field);
      expect(`${res.body.error.message} ${res.body.error.next_action}`, label).not.toMatch(/service_id|customer_name|get_availability|list_services/);
    }
    const unknown = await postJson(f, { service: "perm", start: SAT_1430, name: "Maya" });
    expect(unknown.body.error.next_action).toBe(
      "Call GET /api/shops/harts/services to get valid service ids, then call GET /api/shops/harts/availability for that service and book one of its starts.",
    );
    expect(unknown.body.error.details?.valid_service_ids).toEqual(["haircut", "beard-trim", "haircut-beard"]);
  });
});

describe("POST /api/shops/[shop]/book as a plain HTML form", () => {
  it("303 → that booking's approval page on the request's origin", async () => {
    const f = fixture();
    const res = await bookPost(f.getDeps, bookForm({ service: "haircut", start: SAT_1430, name: "Maya", bookedBy: "Browser agent" }), "harts");
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = res.headers.get("location")!;
    expect(location).toMatch(new RegExp(`^${ORIGIN}/approve/[A-Za-z0-9_-]{43}$`));
    const view = await viewOf(f, location);
    expect(view).toMatchObject({ status: "pending", serviceName: "Haircut", display: "Sat 14 Nov, 2:30 pm EST", customerName: "Maya", agentName: "Browser agent" });
  });

  it("multipart/form-data works too; without bookedBy the agent is web plus the browser's User-Agent", async () => {
    const f = fixture();
    const form = new FormData();
    form.set("service", "beard-trim");
    form.set("start", "2026-11-14T16:30:00-05:00");
    form.set("name", "Lee");
    form.set("submit", "Book"); // unknown fields are ignored
    const res = await bookPost(
      f.getDeps,
      new Request(`${ORIGIN}/api/shops/harts/book`, { method: "POST", body: form, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" } }),
      "harts",
    );
    expect(res.status).toBe(303);
    const view = await viewOf(f, res.headers.get("location")!);
    expect(view.agentName).toBe("web (Mozilla/5.0 (X11; Linux x86_64))");
  });

  it("slot_taken: 303 back to the form's page with ?error and ?message, keeping its own query", async () => {
    const f = fixture();
    await postJson(f, { service: "haircut", start: SAT_1430, name: "Maya" });
    const res = await bookPost(f.getDeps, bookForm({ service: "haircut", start: SAT_1430, name: "Jo" }, `${ORIGIN}/book/harts?service=haircut#times`), "harts");
    expect(res.status).toBe(303);
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(`${ORIGIN}/book/harts`);
    expect(back.hash).toBe("");
    expect(back.searchParams.get("service")).toBe("haircut");
    expect(back.searchParams.get("error")).toBe("slot_taken");
    expect(back.searchParams.get("message")).toBe("That time is already booked.");
  });

  it("outside_hours and a missing field come back the same way; a second error replaces the first", async () => {
    const f = fixture();
    const lunch = await bookPost(f.getDeps, bookForm({ service: "haircut", start: "2026-11-14T12:00:00-05:00", name: "Jo" }), "harts");
    const back = new URL(lunch.headers.get("location")!);
    expect([lunch.status, back.searchParams.get("error"), back.searchParams.get("message")]).toEqual([
      303,
      "outside_hours",
      "That isn't a bookable time for Haircut.",
    ]);

    const again = await bookPost(f.getDeps, bookForm({ service: "haircut", start: SAT_1430 }, back.toString()), "harts");
    const second = new URL(again.headers.get("location")!);
    expect(second.searchParams.getAll("error")).toEqual(["invalid_request"]);
    expect(second.searchParams.get("message")).toBe("name is required and must be 1–80 characters after trimming spaces.");
  });

  it("without a Referer, a refused form post answers the ApiError envelope as JSON with its status", async () => {
    const f = fixture();
    await postJson(f, { service: "haircut", start: SAT_1430, name: "Maya" });
    const res = await bookPost(f.getDeps, bookForm({ service: "haircut", start: SAT_1430, name: "Jo" }, null), "harts");
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error.code).toBe("slot_taken");
  });
});

describe("GET /api/shops/[shop]/booking-page", () => {
  it("the shop, its rules in plain words, and every service with the next 7 days of slots", async () => {
    const f = fixture();
    const res = await bookingPageGet(f.getDeps, get("/api/shops/harts/booking-page"), "harts");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as BookingPageResponse;
    expect(body.shop.name).toBe("Hart's Barbers");
    expect(body.from).toBe("2026-11-09");
    expect(body.bookUrl).toBe(`${ORIGIN}/api/shops/harts/book`);
    expect(body.policies).toMatchObject({ leadTimeMin: 120, paused: false, phone: "+1 212-555-0142" });
    expect(body.policiesText.split("\n")).toEqual([
      "Book at least 2 hours ahead.",
      "Services without a deposit can be booked up to 30 days ahead; services with a deposit up to 6 days ahead.",
      "Cancel at least 24 hours before your appointment and the deposit is released; cancel later and the shop keeps it.",
      `Deposit: ${body.policies.depositRule}`,
      `Late cancellation: ${body.policies.lateCancelRule}`,
      `No-show: ${body.policies.noShowRule}`,
      "Phone: +1 212-555-0142.",
    ]);
    expect(body.services.map((s) => [s.id, s.days.length, s.days[0].date])).toEqual([
      ["haircut", 7, "2026-11-09"],
      ["beard-trim", 7, "2026-11-09"],
      ["haircut-beard", 7, "2026-11-09"],
    ]);
    // Each service's days are what the availability route returns for it.
    for (const service of body.services) {
      const { body: alone } = await availability(f, `?service=${service.id}`);
      expect(service.days).toEqual(alone.days);
    }
  });

  it("never shows the owner's email: the booking page and agents.md are public", async () => {
    const f = fixture({ policies: { ownerEmail: "dana@harts.example" } });
    const page = await (await bookingPageGet(f.getDeps, get("/api/shops/harts/booking-page"), "harts")).text();
    const md = await (await agentsMdGet(f.getDeps, get("/api/shops/harts/agents.md"), "harts")).text();
    expect((JSON.parse(page) as BookingPageResponse).policies).not.toHaveProperty("ownerEmail");
    expect(page).not.toContain("dana@harts.example");
    expect(md).not.toContain("dana@harts.example");
  });

  it("while paused, the first line says so and whom to call", async () => {
    const f = fixture({ policies: { paused: true } });
    const body = (await (await bookingPageGet(f.getDeps, get("/api/shops/harts/booking-page"), "harts")).json()) as BookingPageResponse;
    expect(body.policiesText.split("\n")[0]).toBe("Hart's Barbers isn't taking bookings right now. Call +1 212-555-0142.");
    expect(body.services.every((s) => s.days.every((d) => d.slots.length === 0))).toBe(true);
  });
});

describe("agent guidance", () => {
  it("agents.md: plain text that says how to book over MCP and the web, the approval link and the rules", async () => {
    const f = fixture();
    const res = await agentsMdGet(f.getDeps, get("/api/shops/harts/agents.md"), "harts");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    const mcpAt = text.indexOf(`${ORIGIN}/api/mcp`);
    const webAt = text.indexOf(`GET ${ORIGIN}/api/shops/harts/availability?service=haircut&from=2026-11-09&days=7`);
    expect(mcpAt).toBeGreaterThan(0);
    expect(webAt).toBeGreaterThan(mcpAt); // MCP first, then the web API
    for (const part of [
      "# Book an appointment at Hart's Barbers (for AI agents)",
      "All times are in America/New_York. Today is 2026-11-09 there.",
      "- Haircut: service=haircut, 30 min, $35.00, $10.00 deposit",
      "- Beard trim: service=beard-trim, 15 min, $15.00, no deposit",
      `POST ${ORIGIN}/api/shops/harts/book`,
      "Content-Type: application/json",
      "booking.approval.url",
      "application/x-www-form-urlencoded",
      "The person approves, not you",
      `${ORIGIN}/api/approvals/<token>`,
      "pending (not answered yet), approved",
      "slot_taken (409)",
      "outside_hours (422)",
      "## Rules at Hart's Barbers",
      "Book at least 2 hours ahead.",
      "No-show: If you don't show up, we keep the deposit.",
      "tell the person to call the shop at +1 212-555-0142",
      `${ORIGIN}/.well-known/front-desk.json`,
    ]) {
      expect(text, part).toContain(part);
    }
  });

  it("agents.md for an unknown shop is a 404 envelope", async () => {
    const res = await agentsMdGet(fixture().getDeps, get("/api/shops/nope/agents.md"), "nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("not_found");
  });

  it("/.well-known/front-desk.json: the MCP endpoint, the web API base and agents.md on the request's origin", async () => {
    const res = discoveryGet(get("/api/well-known/front-desk"));
    expect(res.status).toBe(200);
    expect((await res.json()) as FrontDeskDiscovery).toEqual({
      name: "Front Desk",
      description: expect.stringContaining("approves"),
      shop: "harts",
      mcp: `${ORIGIN}/api/mcp`,
      webApi: `${ORIGIN}/api/shops/harts`,
      agentsMd: `${ORIGIN}/api/shops/harts/agents.md`,
      endpoints: {
        availability: `${ORIGIN}/api/shops/harts/availability`,
        book: `${ORIGIN}/api/shops/harts/book`,
        bookingPage: `${ORIGIN}/api/shops/harts/booking-page`,
      },
    });
  });
});

describe("forWeb", () => {
  it("renames MCP fields and tools in message, next_action and details.field; other errors pass through", () => {
    const err = new FrontDeskError(
      "invalid_request",
      "customer_name is required.",
      "Call list_services, then get_availability, then retry with customer_name and service_id.",
      { field: "customer_name", value: null },
    );
    const web = forWeb(err, "harts") as FrontDeskError;
    expect(web.message).toBe("name is required.");
    expect(web.nextAction).toBe(
      "Call GET /api/shops/harts/services, then GET /api/shops/harts/availability, then retry with name and service.",
    );
    expect(web.details).toEqual({ field: "name", value: null });
    expect(forWeb(new FrontDeskError("invalid_request", "x", "y", { field: "toString" }), "harts")).toMatchObject({ details: { field: "toString" } });
    const plain = new Error("boom");
    expect(forWeb(plain, "harts")).toBe(plain);
  });
});
