import { beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  Booking,
  BookResult,
  CancelResult,
  GetAvailabilityResult,
  GetBookingResult,
  GetPoliciesResult,
  ListServicesResult,
  Slot,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { declineBooking } from "../consent/approvals";
import { agentNameFrom, createFrontDeskMcpHandler, SERVER_INSTRUCTIONS } from "./mcp";
import { SEED } from "./memory-store";
import type { FrontDeskDeps } from "./service";
import {
  approvalToken,
  approveAsCustomer,
  customerOf,
  EXAMPLE_BOOKINGS,
  memoryDeps,
  NOW,
  PHONE_E164,
  alertSummary,
  withCatalog,
} from "./test-support";

// End to end through the real MCP handler (the same one /api/mcp mounts), speaking
// stateless Streamable HTTP JSON-RPC. "Now" is Mon 9 Nov 2026, noon in New York, so the coming
// Saturday is 14 Nov (5 days ahead). Each test gets a fresh in-memory store holding the two example
// bookings on that Saturday (10:00–10:45 and 15:00–15:30) and Hart's seeded rules.
let deps: FrontDeskDeps;
beforeEach(() => {
  deps = memoryDeps({ initialBookings: EXAMPLE_BOOKINGS });
});
// Deps are resolved per tool call, the same way the route passes getFrontDeskDeps.
const handler = createFrontDeskMcpHandler(() => deps);

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

type ListedTool = {
  name: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: { required?: string[]; properties?: Record<string, Record<string, unknown>> };
  outputSchema?: unknown;
};

let nextId = 1;
async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await handler(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  // The response is either plain JSON or a single SSE "message" event.
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
  const msg = JSON.parse(json) as { result?: T; error?: unknown };
  if (msg.error) throw new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`);
  return msg.result as T;
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  rpc<ToolResult>("tools/call", { name, arguments: args });

const listTools = async () => (await rpc<{ tools: ListedTool[] }>("tools/list")).tools;

/** The ApiError envelope a failed tool call carries in its text. */
function envelopeOf(result: ToolResult): ApiError["error"] {
  expect(result.isError).toBe(true);
  // Not in structuredContent: clients validate that against outputSchema even on errors.
  expect(result.structuredContent).toBeUndefined();
  return (JSON.parse(result.content[0].text) as ApiError).error;
}

/** book's result without the approval link, as it is once it's no longer awaiting approval. */
function withoutLink(booking: Booking): Booking {
  const copy = { ...booking };
  delete copy.approval;
  return copy;
}
/** An approval link: deps.baseUrl (localhost in tests) + /approve/ + a 43-character base64url token. */
const APPROVAL_URL = /^http:\/\/localhost:3000\/approve\/[A-Za-z0-9_-]{43}$/;
const SAT = { from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" };
const SLOT = "2026-11-14T14:30:00-05:00";
const bookArgs = (extra: Record<string, unknown> = {}) => ({
  service_id: "haircut",
  start: SLOT,
  customer_name: "Maya",
  ...extra,
});

describe("MCP /api/mcp", () => {
  it("lists seven tools with their annotations: five read-only reads, book (not destructive) and cancel (destructive)", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "book",
      "cancel",
      "get_availability",
      "get_booking",
      "get_policies",
      "list_my_bookings",
      "list_services",
    ]);
    for (const name of ["list_services", "get_policies", "get_availability", "get_booking", "list_my_bookings"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    // Each book call places a new hold (or is slot_taken); a repeated cancel is not_cancellable.
    expect(tools.find((t) => t.name === "book")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.find((t) => t.name === "cancel")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });

  it("documents RFC 3339 inputs and the window limit on get_availability", async () => {
    const avail = (await listTools()).find((t) => t.name === "get_availability")!;
    expect(avail.description).toMatch(/14 days/);
    expect(avail.description).toMatch(/America\/New_York/);
    expect(avail.description).toMatch(/paused/);
    expect(avail.inputSchema.properties?.from?.description).toMatch(/RFC 3339/);
    expect(avail.inputSchema.properties?.to?.description).toMatch(/RFC 3339/);
    expect(avail.inputSchema.properties?.from?.format).toBe("date-time");
  });

  it("advertises the required fields and booking_id in the input schemas, and nothing else", async () => {
    const tools = await listTools();
    const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema;
    // customer_name isn't required: a signed-in agent leaves it out (docs/connector-signin.md).
    expect([...(schema("book").required ?? [])].sort()).toEqual(["service_id", "start"]);
    expect(schema("cancel").required).toEqual(["booking_id"]);
    expect(schema("get_booking").required).toEqual(["booking_id"]);
    // Exactly the contract's arguments: no retry key, no phone code.
    expect(Object.keys(schema("book").properties ?? {}).sort()).toEqual(["customer_name", "mandate", "service_id", "start"]);
    expect(Object.keys(schema("cancel").properties ?? {})).toEqual(["booking_id"]);
    for (const name of ["get_booking", "cancel"]) {
      expect(schema(name).properties?.booking_id).toMatchObject({ type: "string" });
    }
  });

  it("tells agents the flow, the rules and the approval step in the descriptions and the server instructions", async () => {
    const tools = await listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description;
    for (const name of ["get_booking", "cancel"]) {
      expect(description(name)).toMatch(/booking_not_found/);
    }
    // get_booking is how the agent learns what the person did with the link.
    expect(description("get_booking")).toMatch(/awaiting_approval/);
    expect(description("get_booking")).toMatch(/confirmed \(approved/);
    expect(description("get_booking")).toMatch(/expired \(the hold ran out/);
    expect(description("get_booking")).toMatch(/booking\.approval\.url is the link to send them again/);
    expect(description("get_booking")).toMatch(/customer\.approved is true/);
    expect(description("cancel")).toMatch(/awaiting approval can be cancelled any time/);
    expect(description("cancel")).toMatch(/cancelWindowHours/);
    expect(description("cancel")).toMatch(/not_cancellable/);
    expect(description("cancel")).toMatch(/depositCollected/);
    for (const code of ["slot_taken", "too_soon", "too_far", "outside_hours", "paused", "outside_mandate"]) {
      expect(description("book")).toContain(code);
    }
    // No codes and no retry keys any more, and the customer is "approved", never anything stronger.
    for (const name of ["book", "cancel", "get_booking"]) {
      expect(description(name)).not.toMatch(/\bkeys?\b|code texted|texted to their phone|verif/i);
    }
    // The server instructions: nothing is final until the person approves through the link.
    expect(SERVER_INSTRUCTIONS).toMatch(/No booking is final until the person approves it themselves/);
    expect(SERVER_INSTRUCTIONS).toMatch(/holds the slot for 10 minutes/);
    expect(SERVER_INSTRUCTIONS).toMatch(/approval link \(booking\.approval\.url\)/);
    expect(SERVER_INSTRUCTIONS).toMatch(/get_booking to check the status/);
    expect(SERVER_INSTRUCTIONS).toMatch(/mandate/);
    expect(SERVER_INSTRUCTIONS).toMatch(/they open it and approve or decline/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bkeys?\b|code texted|verif|identity/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/get_booking returns the same link again/);
  });

  it("list_services shows dollars in text and cents in structuredContent", async () => {
    const result = await callTool("list_services");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("$35.00");
    expect(result.content[0].text).toContain("America/New_York");
    const data = result.structuredContent as ListServicesResult;
    expect(data.shop).toEqual({ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" });
    expect(data.services.find((s) => s.id === "haircut")).toMatchObject({ priceCents: 3500, depositCents: 1000 });
    expect(data.services.find((s) => s.id === "beard-trim")).toMatchObject({ depositCents: 0 });
  });

  it("get_policies returns Hart's rules, and reads them in plain language, without the owner's email", async () => {
    deps = memoryDeps({ policies: { ownerEmail: "dana@example.com" } });
    const result = await callTool("get_policies");
    expect(result.isError).toBeFalsy();
    const { ownerEmail, ...rules } = SEED.policies.harts;
    expect(ownerEmail).toBeNull();
    expect(result.structuredContent).toEqual({
      shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
      policies: rules,
    } satisfies GetPoliciesResult);
    expect(JSON.stringify(result)).not.toContain("dana@example.com");
    const text = result.content[0].text;
    expect(text).toContain("Bookings are open.");
    expect(text).toContain("Book at least 2 hours ahead.");
    expect(text).toContain("up to 30 days ahead");
    expect(text).toContain("up to 6 days ahead");
    expect(text).toContain("at least 24 hours before the start releases the deposit");
    expect(text).toContain("+1 212-555-0142");
    expect(text).toContain(`Deposit: ${SEED.policies.harts.depositRule}`);
    expect(text).toContain(`Late cancellation: ${SEED.policies.harts.lateCancelRule}`);
    expect(text).toContain(`No-show: ${SEED.policies.harts.noShowRule}`);
  });

  it("get_availability returns Saturday slots that skip lunch and the example bookings", async () => {
    const result = await callTool("get_availability", { service_id: "haircut", ...SAT, limit: 50 });
    expect(result.isError).toBeFalsy();
    const { slots, truncated } = result.structuredContent as GetAvailabilityResult;
    const times = slots.map((s) => s.start.slice(11, 16));
    expect(times).not.toContain("10:00"); // booking
    expect(times).not.toContain("12:00"); // lunch
    expect(times).not.toContain("15:00"); // booking
    expect(times).toContain("10:45");
    expect(slots).toHaveLength(21);
    expect(truncated).toBe(false);
  });

  it("returns the ApiError envelope as a tool error for an unknown service", async () => {
    const error = envelopeOf(await callTool("get_availability", { service_id: "perm", ...SAT }));
    expect(error.code).toBe("not_found");
    expect(error.next_action).toMatch(/list_services/);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a 15-day window", { service_id: "haircut", from: SAT.from, to: "2026-11-29T00:00:00-05:00" }],
    ["from after to", { service_id: "haircut", from: SAT.to, to: SAT.from }],
    ["a date with no offset", { service_id: "haircut", from: "2026-11-14", to: SAT.to }],
    ["an out-of-range offset", { service_id: "haircut", from: "2026-11-14T09:00:00+99:99", to: SAT.to }],
    ["a limit over 50", { service_id: "haircut", ...SAT, limit: 99 }],
    ["a limit that is a string", { service_id: "haircut", ...SAT, limit: "5" }],
    ["a missing service_id", { ...SAT }],
    ["a numeric service_id", { service_id: 5, ...SAT }],
    ["a missing to", { service_id: "haircut", from: SAT.from }],
    ["no arguments at all", {}],
  ])("returns the invalid_request envelope for %s", async (_label, args) => {
    const error = envelopeOf(await callTool("get_availability", args));
    expect(error.code).toBe("invalid_request");
    expect(error.next_action.length).toBeGreaterThan(0);
  });

  it("treats limit: null as omitted (default 20)", async () => {
    const result = await callTool("get_availability", { service_id: "haircut", ...SAT, limit: null });
    expect(result.isError).toBeFalsy();
    const { slots, truncated } = result.structuredContent as GetAvailabilityResult;
    expect(slots).toHaveLength(20);
    expect(truncated).toBe(true);
  });

  it("advertises types, formats, limits and required fields in the get_availability input schema", async () => {
    const schema = (await listTools()).find((t) => t.name === "get_availability")!.inputSchema;
    expect([...(schema.required ?? [])].sort()).toEqual(["from", "service_id", "to"]);
    expect(schema.properties?.service_id).toMatchObject({ type: "string" });
    expect(schema.properties?.from).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties?.to).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
  });

  it("while paused: get_availability is empty and says to call the shop; get_policies says PAUSED", async () => {
    deps = memoryDeps({ policies: { paused: true } });
    const avail = await callTool("get_availability", { service_id: "haircut", ...SAT });
    expect(avail.isError).toBeFalsy();
    expect(avail.structuredContent).toEqual({ slots: [], truncated: false });
    expect(avail.content[0].text).toBe(
      "Hart's Barbers isn't taking bookings right now, so there are no open times. " +
        "Tell the person to call the shop at +1 212-555-0142.",
    );
    expect((await callTool("get_policies")).content[0].text).toContain("Bookings are PAUSED");
  });
});

describe("MCP book tool", () => {
  it("is advertised with the hold, the approval link and the rules in its description, and actionable inputs", async () => {
    const tool = (await listTools()).find((t) => t.name === "book")!;
    expect(tool.description).toMatch(/Hold an appointment at Hart's Barbers for 10 minutes until the person approves it/);
    expect(tool.description).toMatch(/status awaiting_approval and booking\.approval\.url/);
    expect(tool.description).toMatch(/get_booking/);
    expect(tool.description).toMatch(/awaiting_deposit/);
    expect(tool.description).toMatch(/They open it and approve \(→ confirmed\) or decline \(→ cancelled\)/);
    expect(tool.description).toMatch(/calling again for the same time gets slot_taken while the hold is on/);
    expect(tool.inputSchema.properties?.start).toMatchObject({ type: "string", format: "date-time" });
    expect(String(tool.inputSchema.properties?.start.description)).toMatch(/returned by get_availability/);
    expect(tool.inputSchema.properties?.customer_name).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
    // The mandate is optional and advertised with its three limits; unknown limits are refused.
    expect(tool.inputSchema.required).not.toContain("mandate");
    const mandate = tool.inputSchema.properties?.mandate as Record<string, unknown> & {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(mandate).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(mandate.properties).sort()).toEqual(["depositCapCents", "priceCapCents", "window"]);
    expect(mandate.properties.priceCapCents).toMatchObject({ type: "integer", minimum: 0 });
    expect(mandate.properties.window).toMatchObject({ type: "object", required: ["from", "to"] });
  });

  it("holds a slot: returns BookResult in awaiting_approval with the approval link, tells the agent what to do, and the slot disappears", async () => {
    const result = await callTool("book", bookArgs());
    expect(result.isError).toBeFalsy();
    const { booking } = result.structuredContent as BookResult;
    expect(booking).toMatchObject({
      shopSlug: "harts",
      serviceId: "haircut",
      serviceName: "Haircut",
      staffId: "dana",
      start: SLOT,
      end: "2026-11-14T15:00:00-05:00",
      display: "Sat 14 Nov, 2:30 pm EST",
      status: "awaiting_approval",
      customer: customerOf("Maya", false),
      agent: { name: "unknown agent" }, // 2025-era requests carry no clientInfo
      depositCents: 1000,
      deposit: { amountCents: 1000, state: "none" },
      createdAt: "2026-11-09T12:00:00-05:00",
      // Held for 10 minutes from now (Mon 9 Nov, noon).
      approval: { url: expect.stringMatching(APPROVAL_URL), expiresAt: "2026-11-09T12:10:00-05:00" },
    });
    expect(booking.customer).not.toHaveProperty("phone");
    const text = result.content[0].text;
    expect(text).toContain("Held Haircut with Dana, Sat 14 Nov, 2:30 pm EST, for Maya. It is not confirmed yet.");
    expect(text).toContain(
      `Hold placed until Mon 9 Nov, 12:10 pm EST. Send Maya this link to approve: ` +
        `${booking.approval!.url}. Then call get_booking to check the status.`,
    );
    // Deposits are off in these deps (no Stripe), so nothing will be charged.
    expect(text).toContain("This service has a $10 deposit, but the shop isn't collecting deposits yet");
    expect(text).toContain(booking.id);
    expect(text).not.toContain("replayed");
    // The owner hears nothing about a hold.
    expect(alertSummary(deps.notifier)).toEqual([]);

    const after = await callTool("get_availability", {
      service_id: "haircut",
      from: "2026-11-14T14:00:00-05:00",
      to: "2026-11-14T16:00:00-05:00",
    });
    const starts = (after.structuredContent as GetAvailabilityResult).slots.map((s) => s.start.slice(11, 16));
    expect(starts).not.toContain("14:30");
  });

  it("refuses the same slot twice with slot_taken and up to 3 nearby alternatives", async () => {
    expect((await callTool("book", bookArgs())).isError).toBeFalsy();
    const error = envelopeOf(await callTool("book", bookArgs({ customer_name: "Jo" })));
    expect(error.code).toBe("slot_taken");
    expect(error.next_action).toMatch(/^Someone just took that time\. Call get_availability again and choose another start\./);
    expect(error.next_action).toMatch(/details\.alternatives/);
    // 14:30–15:00 is now booked and 15:00–15:30 already was: the nearest free haircut starts are before.
    const alternatives = (error.details as { alternatives: Slot[] }).alternatives;
    expect(alternatives.map((s) => s.start.slice(11, 16))).toEqual(["13:30", "13:45", "14:00"]);
  });

  it("returns slot_taken through the envelope when the database refuses an overlap", async () => {
    expect((await callTool("book", bookArgs())).isError).toBeFalsy();
    // Simulate a race: this call's availability check misses the booking above; the store has it.
    let reads = 0;
    deps = withCatalog(deps, (catalog) => ({
      getBusyIntervals: async (slug, range) => (reads++ === 0 ? [] : catalog.getBusyIntervals(slug, range)),
    }));
    const error = envelopeOf(await callTool("book", bookArgs({ customer_name: "Jo" })));
    expect(error.code).toBe("slot_taken");
    expect(error.next_action).toMatch(/^Someone just took that time\. Call get_availability again/);
    expect((error.details as { alternatives: Slot[] }).alternatives.length).toBeGreaterThan(0);
  });

  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ["a past start", { start: "2026-11-09T13:00:00-05:00" }, "too_soon", { earliest: "2026-11-09T14:00:00-05:00" }],
    ["a haircut beyond the 6-day deposit horizon", { start: "2026-11-17T10:00:00-05:00" }, "too_far", { latest: "2026-11-15T12:00:00-05:00" }],
    ["a start during lunch", { start: "2026-11-14T12:00:00-05:00" }, "outside_hours", { field: "start" }],
  ])("returns the envelope for %s: %s", async (_label, extra, code, details) => {
    const error = envelopeOf(await callTool("book", bookArgs(extra)));
    expect(error.code).toBe(code);
    expect(error.details).toMatchObject(details);
    expect(error.next_action.length).toBeGreaterThan(0);
  });

  it("returns the paused envelope with the shop's phone", async () => {
    deps = memoryDeps({ policies: { paused: true } });
    const error = envelopeOf(await callTool("book", bookArgs()));
    expect(error.code).toBe("paused");
    expect(error.details).toEqual({ phone: "+1 212-555-0142" });
    expect(error.next_action).toBe("Tell the person to call the shop at +1 212-555-0142.");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["no arguments", {}, "service_id"],
    ["a missing customer_name", { service_id: "haircut", start: SLOT }, "customer_name"],
    ["a blank customer_name", bookArgs({ customer_name: "   " }), "customer_name"],
    ["an 81-character customer_name", bookArgs({ customer_name: "x".repeat(81) }), "customer_name"],
    ["a start without an offset", bookArgs({ start: "2026-11-14T14:30:00" }), "start"],
    ["a numeric start", bookArgs({ start: 1763148600 }), "start"],
  ])("returns the invalid_request envelope for %s", async (_label, args, field) => {
    const error = envelopeOf(await callTool("book", args));
    expect(error.code).toBe("invalid_request");
    expect(error.details).toMatchObject({ field });
    expect(error.next_action.length).toBeGreaterThan(0);
  });
});

describe("MCP get_booking and cancel", () => {
  it("runs the whole loop: list → policies → availability → book (again: slot_taken) → get → approve → get → cancel (again: not_cancellable) → get", async () => {
    const services = (await callTool("list_services")).structuredContent as ListServicesResult;
    expect(services.services.map((s) => s.id)).toContain("haircut");

    const policies = (await callTool("get_policies")).structuredContent as GetPoliciesResult;
    expect(policies.policies.cancelWindowHours).toBe(24);

    const avail = (await callTool("get_availability", { service_id: "haircut", ...SAT })).structuredContent as GetAvailabilityResult;
    const start = avail.slots.find((s) => s.start === SLOT)!.start;

    const booked = await callTool("book", bookArgs({ start }));
    expect(booked.isError).toBeFalsy();
    const { booking } = booked.structuredContent as BookResult;

    // Calling book again (e.g. a retry) can't double-book: the hold is in the way.
    expect(envelopeOf(await callTool("book", bookArgs({ start }))).code).toBe("slot_taken");

    // get_booking shows the same link again, and says the person hasn't answered yet.
    const waiting = await callTool("get_booking", { booking_id: booking.id });
    expect(waiting.isError).toBeFalsy();
    expect(waiting.structuredContent).toEqual({ booking } satisfies GetBookingResult);
    expect(waiting.content[0].text).toContain("Status: awaiting_approval.");
    expect(waiting.content[0].text).toContain(`Waiting for Maya to approve with this link: ${booking.approval!.url} (the hold lapses at `);
    expect(waiting.content[0].text).toContain(approvalToken(booking));

    // The person approves through the link (giving their phone); get_booking reports it.
    const approved = await approveAsCustomer(deps, booking);
    const fetched = await callTool("get_booking", { booking_id: booking.id });
    expect(fetched.isError).toBeFalsy();
    expect(fetched.structuredContent).toEqual({ booking: approved } satisfies GetBookingResult);
    expect(approved).toEqual({
      ...withoutLink(booking),
      status: "confirmed",
      customer: customerOf("Maya", true, PHONE_E164),
      // Deposits are off in these deps: confirmed without collecting the deposit.
      deposit: { amountCents: 1000, state: "not_collected" },
    });
    expect(fetched.content[0].text).toContain("Status: confirmed.");
    expect(fetched.content[0].text).toContain("Maya approved it. It is confirmed.");

    const cancelled = await callTool("cancel", { booking_id: booking.id });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.structuredContent).toEqual({
      booking: { ...approved, status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    } satisfies CancelResult);
    const text = cancelled.content[0].text;
    expect(text).toContain("Status: cancelled.");
    expect(text).toContain("the $10 deposit is released");
    expect(text).toContain("No deposit was held on the card, so nothing was charged or refunded.");

    // Cancelling again (e.g. a retry) can't cancel twice.
    const recancelled = envelopeOf(await callTool("cancel", { booking_id: booking.id }));
    expect(recancelled.code).toBe("not_cancellable");
    expect(recancelled.details).toMatchObject({ status: "cancelled" });

    const after = await callTool("get_booking", { booking_id: booking.id });
    expect((after.structuredContent as GetBookingResult).booking.status).toBe("cancelled");
  });

  it("cancel of an approved booking inside 24 hours says the shop keeps the deposit", async () => {
    const booked = await callTool("book", bookArgs({ start: "2026-11-10T10:00:00-05:00" }));
    const { booking } = booked.structuredContent as BookResult;
    await approveAsCustomer(deps, booking);
    const cancelled = await callTool("cancel", { booking_id: booking.id });
    expect((cancelled.structuredContent as CancelResult).depositEffect).toBe("captured");
    expect(cancelled.content[0].text).toContain("the shop keeps the $10 deposit as a late-cancellation fee");
  });

  it("cancel of a hold inside 24 hours frees the time without keeping the deposit", async () => {
    const booked = await callTool("book", bookArgs({ start: "2026-11-10T10:00:00-05:00" }));
    const { booking } = booked.structuredContent as BookResult;
    const cancelled = await callTool("cancel", { booking_id: booking.id });
    expect(cancelled.structuredContent).toEqual({
      booking: { ...withoutLink(booking), status: "cancelled" },
      depositEffect: "released",
      depositCollected: false,
    } satisfies CancelResult);
  });

  it("returns booking_not_found for an unknown id from get_booking and cancel", async () => {
    const id = "6f1c2a4e-9b0d-4c3e-8a7f-1d2e3f4a5b6c";
    for (const result of [
      await callTool("get_booking", { booking_id: id }),
      await callTool("cancel", { booking_id: id }),
    ]) {
      const error = envelopeOf(result);
      expect(error.code).toBe("booking_not_found");
      expect(error.details).toEqual({ booking_id: id });
    }
  });

  it("returns not_cancellable when cancelling a cancelled booking", async () => {
    const { booking } = (await callTool("book", bookArgs())).structuredContent as BookResult;
    expect((await callTool("cancel", { booking_id: booking.id })).isError).toBeFalsy();
    const error = envelopeOf(await callTool("cancel", { booking_id: booking.id }));
    expect(error.code).toBe("not_cancellable");
    expect(error.details).toMatchObject({ status: "cancelled" });
  });

  it.each<[string, string, Record<string, unknown>, string]>([
    ["get_booking", "no arguments", {}, "booking_id"],
    ["cancel", "no arguments", {}, "booking_id"],
  ])("%s returns the invalid_request envelope for %s", async (tool, _label, args, field) => {
    const error = envelopeOf(await callTool(tool, args));
    expect(error.code).toBe("invalid_request");
    expect(error.details).toMatchObject({ field });
  });
});

describe("MCP: the hold and the mandate", () => {
  /** A clock the test can move. */
  function movableClock(): Clock & { set(iso: string): void } {
    let at = new Date(NOW.getTime());
    return { now: () => new Date(at.getTime()), set: (iso) => (at = new Date(iso)) };
  }

  it("get_booking reports a lapsed hold as expired, and the time can be booked again", async () => {
    const clock = movableClock();
    deps = memoryDeps({ clock });
    const { booking } = (await callTool("book", bookArgs())).structuredContent as BookResult;
    clock.set("2026-11-09T12:10:00-05:00"); // the hold's deadline

    const fetched = await callTool("get_booking", { booking_id: booking.id });
    expect((fetched.structuredContent as GetBookingResult).booking.status).toBe("expired");
    expect(fetched.content[0].text).toContain("Status: expired.");
    expect(fetched.content[0].text).toContain("The hold ran out before Maya approved, so the time is free again.");

    const again = await callTool("book", bookArgs({ customer_name: "Jo" }));
    expect(again.isError).toBeFalsy();
    expect((again.structuredContent as BookResult).booking).toMatchObject({ start: SLOT, status: "awaiting_approval" });
  });

  it("get_availability skips a live hold but offers a lapsed one again, before anyone expires it", async () => {
    const clock = movableClock();
    deps = memoryDeps({ clock });
    await callTool("book", bookArgs());
    const window = { service_id: "haircut", from: "2026-11-14T14:00:00-05:00", to: "2026-11-14T15:00:00-05:00" };
    const starts = async () =>
      ((await callTool("get_availability", window)).structuredContent as GetAvailabilityResult).slots.map((s) => s.start);
    expect(await starts()).not.toContain(SLOT);
    clock.set("2026-11-09T12:10:01-05:00");
    expect(await starts()).toContain(SLOT);
  });

  it("get_booking says when the person declined", async () => {
    const { booking } = (await callTool("book", bookArgs())).structuredContent as BookResult;
    await declineBooking(deps, approvalToken(booking));
    const fetched = await callTool("get_booking", { booking_id: booking.id });
    expect((fetched.structuredContent as GetBookingResult).booking.status).toBe("cancelled");
    expect(fetched.content[0].text).toContain("Maya declined it, so the time is free again.");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a price cap below the haircut's $35", { priceCapCents: 3499 }, "price_cap"],
    ["a deposit cap below its $10 deposit", { depositCapCents: 999 }, "deposit_cap"],
    ["a window that ends before the haircut does", { window: { from: SAT.from, to: "2026-11-14T14:45:00-05:00" } }, "window"],
  ])("refuses %s with outside_mandate", async (_label, mandate, field) => {
    const error = envelopeOf(await callTool("book", bookArgs({ mandate })));
    expect(error.code).toBe("outside_mandate");
    expect(error.details).toMatchObject({ field });
    expect(error.next_action).toBe("Ask the person to widen their limit, or choose a different service or time.");
  });

  it("books within the mandate's limits", async () => {
    const mandate = { priceCapCents: 3500, depositCapCents: 1000, window: { from: SLOT, to: "2026-11-14T15:00:00-05:00" } };
    const result = await callTool("book", bookArgs({ mandate }));
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as BookResult).booking.status).toBe("awaiting_approval");
  });

  it.each<[string, unknown, string]>([
    ["a mandate that isn't an object", "50 dollars", "mandate"],
    ["an unknown limit", { maxPrice: 5000 }, "mandate.maxPrice"],
    ["a negative cap", { priceCapCents: -1 }, "mandate.priceCapCents"],
    ["a cap in dollars", { priceCapCents: 35.5 }, "mandate.priceCapCents"],
    ["a window without an offset", { window: { from: "2026-11-14T09:00:00", to: SAT.to } }, "mandate.window.from"],
    ["a window that ends before it starts", { window: { from: SAT.to, to: SAT.from } }, "mandate.window.to"],
  ])("returns the invalid_request envelope for %s", async (_label, mandate, field) => {
    const error = envelopeOf(await callTool("book", bookArgs({ mandate })));
    expect(error.code).toBe("invalid_request");
    expect(error.details).toMatchObject({ field });
  });

  it("treats mandate: null as no mandate", async () => {
    expect((await callTool("book", bookArgs({ mandate: null }))).isError).toBeFalsy();
  });
});

describe("agentNameFrom", () => {
  it("reads the MCP client's name from the 2026-07-28 request envelope", () => {
    const ctx = { mcpReq: { envelope: { "io.modelcontextprotocol/clientInfo": { name: "claude-ai", version: "1.0" } } } };
    expect(agentNameFrom(ctx)).toBe("claude-ai");
  });

  it("falls back to 'unknown agent' when the request carries no client name", () => {
    expect(agentNameFrom(undefined)).toBe("unknown agent");
    expect(agentNameFrom({ mcpReq: {} })).toBe("unknown agent");
    expect(agentNameFrom({ mcpReq: { envelope: { "io.modelcontextprotocol/clientInfo": { name: "  " } } } })).toBe(
      "unknown agent",
    );
  });
});
