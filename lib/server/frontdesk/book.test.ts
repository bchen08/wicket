import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookInput } from "../../types/frontdesk";
import { FrontDeskError } from "./errors";
import { book, getAvailability, type FrontDeskDeps } from "./service";
import { memoryDeps, recordingNotifier, SAT } from "./test-support";

// book() against the in-memory store with a fixed clock: Sat 7 Nov 2026, noon in New York.
// Dana works Tue–Sat 09:00–12:00 and 12:30–17:00. Saturday 14 Nov starts with no bookings.

const at = (hhmm: string) => `2026-11-14T${hhmm}:00-05:00`;
const haircut = (start: string, customer_name = "Maya"): BookInput => ({ service_id: "haircut", start, customer_name });

async function rejection(promise: Promise<unknown>): Promise<FrontDeskError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FrontDeskError);
    return err as FrontDeskError;
  }
  throw new Error("expected a FrontDeskError");
}

async function saturdayStarts(deps: FrontDeskDeps, service_id = "haircut"): Promise<string[]> {
  const { slots } = await getAvailability(deps, "harts", { service_id, ...SAT, limit: 50 });
  return slots.map((s) => s.start);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("book", () => {
  it("books a valid slot as a confirmed Booking, and get_availability stops offering it", async () => {
    const notifier = recordingNotifier();
    const deps = memoryDeps({ notifier });
    expect(await saturdayStarts(deps)).toContain(at("14:30"));

    const { booking, staffName } = await book(deps, "harts", haircut(at("14:30"), "  Maya Lopez  "), "claude-ai");

    expect(booking).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      shopSlug: "harts",
      serviceId: "haircut",
      serviceName: "Haircut",
      staffId: "dana",
      start: at("14:30"),
      end: at("15:00"),
      display: "Sat 14 Nov, 2:30 pm EST",
      status: "confirmed",
      customer: { displayName: "Maya Lopez", verified: false },
      agent: { name: "claude-ai" },
      depositCents: 1000,
      createdAt: "2026-11-07T12:00:00-05:00",
    });
    expect(staffName).toBe("Dana");
    expect(notifier.alerts).toEqual([booking]);

    const after = await saturdayStarts(deps);
    // A 30-minute haircut at 14:30 blocks 14:15 (would run to 14:45), 14:30 and 14:45.
    for (const t of ["14:15", "14:30", "14:45"]) expect(after).not.toContain(at(t));
    for (const t of ["14:00", "15:00"]) expect(after).toContain(at(t));
  });

  it("accepts the same instant written with another offset", async () => {
    const { booking } = await book(memoryDeps(), "harts", haircut("2026-11-14T19:30:00Z"), "agent");
    expect(booking.start).toBe(at("14:30"));
  });

  it("refuses the same slot twice with slot_taken", async () => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("10:00")), "agent A");
    const err = await rejection(book(deps, "harts", haircut(at("10:00"), "Jo"), "agent B"));
    expect(err.code).toBe("slot_taken");
    expect(err.nextAction).toBe("Someone just took that time. Call get_availability again and choose another start.");
  });

  it("refuses an overlapping service: haircut-beard at 9:45 runs into a haircut at 10:00", async () => {
    const deps = memoryDeps();
    await book(deps, "harts", haircut(at("10:00")), "agent A");
    const err = await rejection(
      book(deps, "harts", { service_id: "haircut-beard", start: at("09:45"), customer_name: "Jo" }, "agent B"),
    );
    expect(err.code).toBe("slot_taken");
    // Back to back is fine: a 15-minute beard trim at 9:45 ends exactly at 10:00.
    const { booking } = await book(deps, "harts", { service_id: "beard-trim", start: at("09:45"), customer_name: "Jo" }, "B");
    expect(booking.end).toBe(at("10:00"));
  });

  it("lets the store have the final word when availability looked free (a race between two agents)", async () => {
    const deps = memoryDeps();
    // A catalog that never sees bookings, as if both agents checked before either inserted.
    const stale: FrontDeskDeps = { ...deps, catalog: { ...deps.catalog, getBusyIntervals: async () => [] } };
    await book(stale, "harts", haircut(at("10:00")), "agent A");
    const err = await rejection(
      book(stale, "harts", { service_id: "haircut-beard", start: at("09:45"), customer_name: "Jo" }, "agent B"),
    );
    expect(err.code).toBe("slot_taken");
    expect(err.nextAction).toMatch(/Call get_availability again/);
  });

  it.each<[string, BookInput]>([
    ["an off-grid start (10:05)", haircut(at("10:05"))],
    ["a start during lunch (12:00)", haircut(at("12:00"))],
    ["a start that would run into lunch (11:45)", haircut(at("11:45"))],
    ["a start outside opening hours (08:30)", haircut(at("08:30"))],
    ["a past start (today 09:00, now is noon)", haircut("2026-11-07T09:00:00-05:00")],
    ["a day the shop is closed (Sunday)", haircut("2026-11-15T10:00:00-05:00")],
  ])("refuses %s with invalid_request and a next_action", async (_label, input) => {
    const err = await rejection(book(memoryDeps(), "harts", input, "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe("That start time isn't available.");
    expect(err.nextAction).toBe("Call get_availability and choose one of the returned starts.");
    expect(err.details).toMatchObject({ field: "start" });
  });

  it("refuses an unknown service with invalid_request pointing at list_services", async () => {
    const err = await rejection(book(memoryDeps(), "harts", { ...haircut(at("10:00")), service_id: "perm" }, "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.nextAction).toMatch(/list_services/);
    expect(err.details).toMatchObject({ field: "service_id", valid_service_ids: ["haircut", "beard-trim", "haircut-beard"] });
  });

  it.each<[string, BookInput, string]>([
    ["a start without an offset", haircut("2026-11-14T10:00:00"), "start"],
    ["a date-only start", haircut("2026-11-14"), "start"],
    ["an empty customer name", haircut(at("10:00"), ""), "customer_name"],
    ["a customer name of only spaces", haircut(at("10:00"), "   "), "customer_name"],
    ["an 81-character customer name", haircut(at("10:00"), "x".repeat(81)), "customer_name"],
  ])("refuses %s with invalid_request and a next_action", async (_label, input, field) => {
    const err = await rejection(book(memoryDeps(), "harts", input, "agent"));
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ field });
    expect(err.nextAction.length).toBeGreaterThan(0);
  });

  it("accepts an 80-character customer name (the limit), after trimming", async () => {
    const name = "x".repeat(80);
    const { booking } = await book(memoryDeps(), "harts", haircut(at("10:00"), ` ${name} `), "agent");
    expect(booking.customer.displayName).toBe(name);
  });

  it("is not_found for an unknown shop", async () => {
    const err = await rejection(book(memoryDeps(), "nope", haircut(at("10:00")), "agent"));
    expect(err.code).toBe("not_found");
  });

  it("labels a booking 'unknown agent' when the agent name is blank, and caps it at 80 characters", async () => {
    const deps = memoryDeps();
    expect((await book(deps, "harts", haircut(at("09:00")), "  ")).booking.agent.name).toBe("unknown agent");
    expect((await book(deps, "harts", haircut(at("09:30")), "a".repeat(200))).booking.agent.name).toHaveLength(80);
  });

  it("still books when the notifier throws, and logs the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = memoryDeps({
      notifier: {
        async alertOwner() {
          throw new Error("SMTP is down");
        },
      },
    });

    const { booking } = await book(deps, "harts", haircut(at("11:00")), "agent");
    expect(booking.status).toBe("confirmed");
    expect(await saturdayStarts(deps)).not.toContain(at("11:00"));
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(errors.mock.calls[0][0]));
    expect(logged).toMatchObject({ event: "booking.notify_failed", id: booking.id, error: "SMTP is down" });
  });
});
