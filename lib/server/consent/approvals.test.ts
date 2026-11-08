import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, Mandate } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { FrontDeskError } from "../frontdesk/errors";
import type { MemoryStore } from "../frontdesk/memory-store";
import { book, cancelBooking, getAvailability, getBooking, type FrontDeskDeps } from "../frontdesk/service";
import { approvalToken, customerOf, memoryDeps, NOW, PHONE_E164, recordingNotifier, SAT } from "../frontdesk/test-support";
import { approveBooking, declineBooking, getApprovalView } from "./approvals";
import { newApprovalToken } from "./crypto";

// The consent flow through its use cases (what /api/approvals/* call), on the in-memory store with a
// clock the tests move. Opening the link and approving is the consent: no phone code (TODO(ring-1c)).
// "Now" starts at Mon 9 Nov 2026, noon in New York; the holds are for Sat 14 Nov.

type MovableClock = Clock & { advance(ms: number): void };
function movableClock(start: Date): MovableClock {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms;
    },
  };
}

const MIN = 60_000;
const SAT_1400 = "2026-11-14T14:00:00-05:00";
const SAT_1500 = "2026-11-14T15:30:00-05:00";

let clock: MovableClock;
let notifier: ReturnType<typeof recordingNotifier>;
let deps: FrontDeskDeps;
let store: MemoryStore;

beforeEach(() => {
  clock = movableClock(NOW);
  notifier = recordingNotifier();
  deps = memoryDeps({ clock, notifier });
  store = deps.store as MemoryStore;
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function hold(start = SAT_1400, options: { name?: string; mandate?: Mandate; service?: string } = {}): Promise<Booking> {
  const result = await book(
    deps,
    "harts",
    {
      service_id: options.service ?? "haircut",
      start,
      customer_name: options.name ?? "Maya Lopez",
      ...(options.mandate ? { mandate: options.mandate } : {}),
    },
    "Claude",
  );
  return result.booking;
}

async function failure(promise: Promise<unknown>, code: string): Promise<FrontDeskError> {
  const err = await promise.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FrontDeskError);
  expect((err as FrontDeskError).code).toBe(code);
  return err as FrontDeskError;
}

async function offeredStarts(): Promise<string[]> {
  return (await getAvailability(deps, "harts", { service_id: "haircut", ...SAT, limit: 50 })).slots.map((s) => s.start);
}

const eventsOf = async (id: string) => (await store.listEvents(id)).map((e) => [e.type, e.actor]);

describe("GET view", () => {
  it("shows a pending hold: the booking, the shop's rules, who asked, the mandate and when it lapses", async () => {
    const booking = await hold(SAT_1400, { mandate: { priceCapCents: 5000, window: { from: SAT.from, to: SAT.to } } });
    const view = await getApprovalView(deps, approvalToken(booking));
    expect(view).toEqual({
      status: "pending",
      shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
      serviceName: "Haircut",
      display: "Sat 14 Nov, 2:00 pm EST",
      start: SAT_1400,
      end: "2026-11-14T14:30:00-05:00",
      priceCents: 3500,
      depositCents: 1000,
      deposit: { amountCents: 1000, state: "none" },
      policies: {
        cancelWindowHours: 24,
        depositRule: expect.stringContaining("deposit"),
        lateCancelRule: expect.stringContaining("24 hours"),
        noShowRule: expect.stringContaining("show"),
      },
      agentName: "Claude",
      customerName: "Maya Lopez",
      mandate: { priceCapCents: 5000, window: { from: SAT.from, to: SAT.to } },
      expiresAt: "2026-11-09T12:10:00-05:00",
    });
  });

  it("leaves out an absent mandate, and has no code fields", async () => {
    const view = await getApprovalView(deps, approvalToken(await hold()));
    expect(view).not.toHaveProperty("mandate");
    expect(view).not.toHaveProperty("codeSentTo");
  });

  it("is booking_not_found for an unknown or malformed token, without echoing it", async () => {
    for (const token of [newApprovalToken(), "short", "../../etc/passwd"]) {
      const err = await failure(getApprovalView(deps, token), "booking_not_found");
      expect(JSON.stringify([err.message, err.nextAction, err.details])).not.toContain(token);
    }
  });
});

describe("approve", () => {
  it("with no body → confirmed, approved, no phone; owner notified exactly once; history booked → approved", async () => {
    const booking = await hold();
    expect(booking.status).toBe("awaiting_approval");
    expect(notifier.alerts).toHaveLength(0); // never for a hold
    const token = approvalToken(booking);

    clock.advance(2 * MIN);
    const { booking: approved } = await approveBooking(deps, token);
    expect(approved).toMatchObject({
      id: booking.id,
      status: "confirmed",
      customer: customerOf("Maya Lopez", true),
    });
    expect(approved.customer).not.toHaveProperty("phone");
    expect(approved).not.toHaveProperty("approval");
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]).toMatchObject({
      kind: "booking_confirmed",
      cancelledBy: null,
      booking: { id: booking.id, status: "confirmed", customer: { approved: true } },
    });

    // get_booking and the view agree; the history shows who did what.
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking).toEqual(approved);
    expect((await getApprovalView(deps, token)).status).toBe("approved");
    expect(await eventsOf(booking.id)).toEqual([
      ["booked", "agent"],
      ["approved", "customer"],
    ]);
    expect((await store.listEvents(booking.id))[1].data).toEqual({
      from: "awaiting_approval",
      to: "confirmed",
      depositEffect: "none",
      depositCollected: false,
    });

    // Answering again is closed, and doesn't notify again.
    await failure(approveBooking(deps, token), "approval_closed");
    await failure(declineBooking(deps, token), "approval_closed");
    expect(notifier.alerts).toHaveLength(1);
  });

  it("with {} → confirmed without a phone, like no body", async () => {
    const { booking } = await approveBooking(deps, approvalToken(await hold()), {});
    expect(booking.customer).toEqual(customerOf("Maya Lopez", true));
    expect(store.consentRows().bookings[0].customerPhone).toBeNull();
  });

  it("with a phone (separators ignored) → stored as plain E.164 and shown as customer.phone", async () => {
    const booking = await hold();
    const { booking: approved } = await approveBooking(deps, approvalToken(booking), { phone: "+1 (401) 555-0123" });
    expect(approved.customer).toEqual(customerOf("Maya Lopez", true, PHONE_E164));
    expect(store.consentRows().bookings.find((b) => b.id === booking.id)?.customerPhone).toBe(PHONE_E164);
    expect((await store.listEvents(booking.id))[1].data).not.toHaveProperty("phone");
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.customer.phone).toBe(PHONE_E164);
  });

  it("treats a null or empty phone as none", async () => {
    for (const phone of [null, ""]) {
      const { booking } = await approveBooking(deps, approvalToken(await hold(phone === null ? SAT_1400 : SAT_1500)), { phone });
      expect(booking.customer).toEqual(customerOf("Maya Lopez", true));
    }
  });

  it("a phone that isn't E.164 is invalid_request (field phone), not echoed, and nothing is approved", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    for (const phone of ["6175559876", "+0123", "call me", 16175559876]) {
      const err = await failure(approveBooking(deps, token, { phone }), "invalid_request");
      expect(err.details).toEqual({ field: "phone" });
      expect(JSON.stringify([err.message, err.nextAction])).not.toContain("6175559876");
    }
    for (const body of [[1], "+16175559876", 42]) {
      const err = await failure(approveBooking(deps, token, body), "invalid_request");
      expect(err.details).toEqual({ field: "body" });
    }
    expect((await getApprovalView(deps, token)).status).toBe("pending");
    expect(notifier.alerts).toHaveLength(0);
  });

  it("two approvals racing: one confirms, the other is approval_closed, one owner alert", async () => {
    const token = approvalToken(await hold());
    const results = await Promise.allSettled([approveBooking(deps, token), approveBooking(deps, token, { phone: PHONE_E164 })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as FrontDeskError;
    expect(reason.code).toBe("approval_closed");
    expect(notifier.alerts).toHaveLength(1);
  });

  it("works for every hold separately: approving one leaves the others pending", async () => {
    const first = await hold(SAT_1400, { name: "Maya" });
    const second = await hold(SAT_1500, { name: "Lee" });
    await approveBooking(deps, approvalToken(first), { phone: PHONE_E164 });
    expect((await getApprovalView(deps, approvalToken(second))).status).toBe("pending");
    expect((await getBooking(deps, "harts", { booking_id: second.id })).booking.customer).toEqual(customerOf("Lee", false));
  });

  it("at approveBy exactly → approval_expired: ask your agent to book again; nothing is notified", async () => {
    const booking = await hold();
    clock.advance(10 * MIN);
    const err = await failure(approveBooking(deps, approvalToken(booking)), "approval_expired");
    expect(err.nextAction).toBe("Ask your agent to book again.");
    expect(notifier.alerts).toHaveLength(0);
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("expired");
  });
});

describe("decline", () => {
  it("→ cancelled by the customer, the slot is freed, the owner is alerted once, and the link is closed", async () => {
    const booking = await hold();
    expect(await offeredStarts()).not.toContain(SAT_1400);
    const { booking: declined } = await declineBooking(deps, approvalToken(booking));
    expect(declined).toMatchObject({ status: "cancelled", customer: { approved: false } });
    expect(store.lifecycleStamps(booking.id)?.cancelledBy).toBe("customer");
    expect(await offeredStarts()).toContain(SAT_1400);
    expect(notifier.alerts.map((a) => [a.kind, a.booking.id, a.booking.status, a.cancelledBy])).toEqual([
      ["booking_cancelled", booking.id, "cancelled", "customer"],
    ]);
    expect(await eventsOf(booking.id)).toEqual([
      ["booked", "agent"],
      ["declined", "customer"],
    ]);
    expect((await getApprovalView(deps, approvalToken(booking))).status).toBe("declined");
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).declined).toBe(true);
    await failure(declineBooking(deps, approvalToken(booking)), "approval_closed");
    await failure(approveBooking(deps, approvalToken(booking)), "approval_closed");
    // Someone else can book the time now.
    expect((await hold(SAT_1400, { name: "Sam" })).status).toBe("awaiting_approval");
  });
});

describe("a hold that lapses", () => {
  it("reads as expired, can't be answered, and the slot can be booked again", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    clock.advance(10 * MIN);
    expect(await offeredStarts()).toContain(SAT_1400); // read-only: skipped without a write
    expect(await eventsOf(booking.id)).toEqual([["booked", "agent"]]);

    expect((await getApprovalView(deps, token)).status).toBe("expired");
    expect(await eventsOf(booking.id)).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
    await failure(approveBooking(deps, token), "approval_expired");
    await failure(declineBooking(deps, token), "approval_expired");

    const again = await hold(SAT_1400, { name: "Sam" });
    expect(again.status).toBe("awaiting_approval");
    expect(again.id).not.toBe(booking.id);
  });

  it("a stale hold never blocks a new booking, even before anything read it", async () => {
    const booking = await hold();
    clock.advance(11 * MIN);
    const again = await hold(SAT_1400, { name: "Sam" });
    expect(again.status).toBe("awaiting_approval");
    expect((await store.getBooking(booking.id))?.status).toBe("expired");
    expect(await eventsOf(booking.id)).toEqual([
      ["booked", "agent"],
      ["expired", "system"],
    ]);
  });

  it("an agent cancel after the lapse is not_cancellable: it already expired", async () => {
    const booking = await hold();
    clock.advance(10 * MIN);
    await failure(cancelBooking(deps, "harts", { booking_id: booking.id }), "not_cancellable");
  });
});

describe("an agent or the shop withdraws the hold", () => {
  it("agent cancel → cancelled; the link shows expired and refuses answers as closed", async () => {
    const booking = await hold();
    const result = await cancelBooking(deps, "harts", { booking_id: booking.id });
    expect(result).toMatchObject({ booking: { status: "cancelled" }, depositEffect: "released", depositCollected: false });
    expect((await getApprovalView(deps, approvalToken(booking))).status).toBe("expired");
    await failure(approveBooking(deps, approvalToken(booking)), "approval_closed");
    await failure(declineBooking(deps, approvalToken(booking)), "approval_closed");
    expect(await offeredStarts()).toContain(SAT_1400);
  });
});

describe("secrets stay out of the logs", () => {
  it("no token or full phone number is logged during the whole flow", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const booking = await hold();
    const token = approvalToken(booking);
    await failure(approveBooking(deps, token, { phone: "nope" }), "invalid_request");
    await approveBooking(deps, token, { phone: PHONE_E164 });
    const logged = lines.join("\n");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("4015550123");
  });
});
