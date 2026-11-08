import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, Mandate } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { FrontDeskError } from "../frontdesk/errors";
import type { MemoryStore } from "../frontdesk/memory-store";
import { book, cancelBooking, getAvailability, getBooking, type FrontDeskDeps } from "../frontdesk/service";
import {
  approvalToken,
  lastSentCode,
  memoryDeps,
  NOW,
  OTHER_PHONE_E164,
  PHONE_E164,
  recordingCodeSender,
  recordingNotifier,
  SAT,
} from "../frontdesk/test-support";
import { approveBooking, declineBooking, getApprovalView, sendApprovalCode } from "./approvals";
import { newApprovalToken, sha256Hex } from "./crypto";

// The consent flow through its use cases (what /api/approvals/* and the MCP tools call), on the
// in-memory store with a clock the tests move. "Now" starts at Mon 9 Nov 2026, noon in New York; the
// holds are for Sat 14 Nov.

type MovableClock = Clock & { set(iso: string): void; advance(ms: number): void };
function movableClock(start: Date): MovableClock {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    set: (iso) => {
      at = new Date(iso).getTime();
    },
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
let codes: ReturnType<typeof recordingCodeSender>;
let deps: FrontDeskDeps;
let store: MemoryStore;

beforeEach(() => {
  clock = movableClock(NOW);
  notifier = recordingNotifier();
  codes = recordingCodeSender();
  deps = memoryDeps({ clock, notifier, codeSender: codes });
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
      idempotency_key: crypto.randomUUID(),
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

  it("shows codeSentTo while the latest code is usable, and leaves out an absent mandate", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    expect(await getApprovalView(deps, token)).not.toHaveProperty("mandate");
    expect(await getApprovalView(deps, token)).not.toHaveProperty("codeSentTo");
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    expect((await getApprovalView(deps, token)).codeSentTo).toBe("0123");
  });

  it("is booking_not_found for an unknown or malformed token, without echoing it", async () => {
    for (const token of [newApprovalToken(), "short", "../../etc/passwd"]) {
      const err = await failure(getApprovalView(deps, token), "booking_not_found");
      expect(JSON.stringify([err.message, err.nextAction, err.details])).not.toContain(token);
    }
  });
});

describe("the approve path", () => {
  it("send code → approve → confirmed, verified, phoneLast4 set, owner notified exactly once", async () => {
    const booking = await hold();
    expect(booking.status).toBe("awaiting_approval");
    expect(notifier.alerts).toHaveLength(0); // never for a hold

    const token = approvalToken(booking);
    const sent = await sendApprovalCode(deps, token, { phone: "+1 (401) 555-0123" });
    expect(sent).toEqual({ sentTo: "0123", expiresAt: "2026-11-09T12:10:00-05:00" }); // no devCode by default
    expect(codes.sent).toEqual([{ phoneE164: PHONE_E164, code: expect.stringMatching(/^\d{6}$/), shopName: "Hart's Barbers", bookingId: booking.id }]);

    clock.advance(2 * MIN);
    const { booking: approved } = await approveBooking(deps, token, { code: lastSentCode(deps) });
    expect(approved).toMatchObject({
      id: booking.id,
      status: "confirmed",
      customer: { displayName: "Maya Lopez", verified: true, phoneLast4: "0123" },
    });
    expect(approved).not.toHaveProperty("approval");
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]).toMatchObject({ id: booking.id, status: "confirmed", customer: { verified: true } });

    // get_booking and the view agree; the history shows who did what.
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking).toEqual(approved);
    expect((await getApprovalView(deps, token)).status).toBe("approved");
    expect(await eventsOf(booking.id)).toEqual([
      ["booked", "agent"],
      ["approved", "customer"],
    ]);
    const approvedEvent = (await store.listEvents(booking.id))[1];
    expect(approvedEvent.data).toEqual({
      from: "awaiting_approval",
      to: "confirmed",
      depositEffect: "none",
      depositCollected: false,
      phoneLast4: "0123",
    });

    // Answering again is closed, and doesn't notify again.
    await failure(approveBooking(deps, token, { code: lastSentCode(deps) }), "approval_closed");
    await failure(declineBooking(deps, token), "approval_closed");
    await failure(sendApprovalCode(deps, token, { phone: PHONE_E164 }), "approval_closed");
    expect(notifier.alerts).toHaveLength(1);
  });

  it("stores the plain E.164 number (never the token or the code); the customer is reused by phone", async () => {
    const first = await hold(SAT_1400, { name: "Maya" });
    const second = await hold(SAT_1500, { name: "Maya L." });
    const a = await approveAsPerson(first, PHONE_E164);
    const b = await approveAsPerson(second, "+1 401 555 0123");
    const rows = store.consentRows();
    expect(rows.customers).toHaveLength(1);
    expect(rows.customers[0]).toMatchObject({ phone: PHONE_E164, displayName: "Maya L." });
    expect(rows.challenges.map((c) => c.phone)).toEqual([PHONE_E164, PHONE_E164]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(approvalToken(first));
    for (const message of codes.sent) expect(dump).not.toContain(`"${message.code}"`);
    expect(rows.bookings.find((r) => r.id === a.id)?.customerId).toBe(rows.customers[0].id);
    expect(rows.bookings.find((r) => r.id === b.id)?.customerId).toBe(rows.customers[0].id);
  });

  it("includes devCode only when dev codes are on", async () => {
    deps = memoryDeps({ clock, notifier, codeSender: codes, consent: { devCodes: true } });
    store = deps.store as MemoryStore;
    const booking = await hold();
    const sent = await sendApprovalCode(deps, approvalToken(booking), { phone: PHONE_E164 });
    expect(sent.devCode).toMatch(/^\d{6}$/);
    expect(sent.devCode).toBe(lastSentCode(deps)); // the sender is still called
    const { booking: approved } = await approveBooking(deps, approvalToken(booking), { code: sent.devCode as string });
    expect(approved.status).toBe("confirmed");
  });

  it("two approvals racing with the right code: one confirms, the other fails, one owner alert", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const code = lastSentCode(deps);
    const results = await Promise.allSettled([approveBooking(deps, token, { code }), approveBooking(deps, token, { code })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as FrontDeskError;
    expect(["code_invalid", "approval_closed"]).toContain(reason.code);
    expect(notifier.alerts).toHaveLength(1);
  });

  it("a lapse between the code and the approval → approval_expired: ask your agent to book again", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    clock.advance(9 * MIN);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    clock.advance(1 * MIN); // exactly approveBy
    const err = await failure(approveBooking(deps, token, { code: lastSentCode(deps) }), "approval_expired");
    expect(err.nextAction).toBe("Ask your agent to book again.");
    expect(notifier.alerts).toHaveLength(0);
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.status).toBe("expired");
  });
});

/** Approve `booking` with a code sent to `phone`. */
async function approveAsPerson(booking: Booking, phone: string): Promise<Booking> {
  const token = approvalToken(booking);
  await sendApprovalCode(deps, token, { phone });
  return (await approveBooking(deps, token, { code: lastSentCode(deps) })).booking;
}

describe("decline", () => {
  it("→ cancelled by the customer, the slot is freed, no owner alert, and the link is closed", async () => {
    const booking = await hold();
    expect(await offeredStarts()).not.toContain(SAT_1400);
    const { booking: declined } = await declineBooking(deps, approvalToken(booking));
    expect(declined).toMatchObject({ status: "cancelled", customer: { verified: false } });
    expect(store.lifecycleStamps(booking.id)?.cancelledBy).toBe("customer");
    expect(await offeredStarts()).toContain(SAT_1400);
    expect(notifier.alerts).toHaveLength(0);
    expect(await eventsOf(booking.id)).toEqual([
      ["booked", "agent"],
      ["declined", "customer"],
    ]);
    expect((await getApprovalView(deps, approvalToken(booking))).status).toBe("declined");
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).declined).toBe(true);
    await failure(declineBooking(deps, approvalToken(booking)), "approval_closed");
    await failure(sendApprovalCode(deps, approvalToken(booking), { phone: PHONE_E164 }), "approval_closed");
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
    await failure(sendApprovalCode(deps, token, { phone: PHONE_E164 }), "approval_expired");
    await failure(declineBooking(deps, token), "approval_expired");
    expect(codes.sent).toHaveLength(0);

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
    await failure(cancelBooking(deps, "harts", { booking_id: booking.id, idempotency_key: crypto.randomUUID() }), "not_cancellable");
  });
});

describe("an agent or the shop withdraws the hold", () => {
  it("agent cancel → cancelled; the link shows expired and refuses codes as closed", async () => {
    const booking = await hold();
    const result = await cancelBooking(deps, "harts", { booking_id: booking.id, idempotency_key: crypto.randomUUID() });
    expect(result).toMatchObject({ booking: { status: "cancelled" }, depositEffect: "released", depositCollected: false });
    expect((await getApprovalView(deps, approvalToken(booking))).status).toBe("expired");
    await failure(sendApprovalCode(deps, approvalToken(booking), { phone: PHONE_E164 }), "approval_closed");
    expect(await offeredStarts()).toContain(SAT_1400);
  });
});

describe("codes", () => {
  it("5 wrong codes → code_invalid with attempts left, then too_many_attempts; then even the right one fails until a new code", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const right = lastSentCode(deps);
    const wrong = right === "000000" ? "111111" : "000000";
    for (const left of [4, 3, 2, 1]) {
      const err = await failure(approveBooking(deps, token, { code: wrong }), "code_invalid");
      expect(err.details).toEqual({ attemptsLeft: left });
    }
    await failure(approveBooking(deps, token, { code: wrong }), "too_many_attempts");
    await failure(approveBooking(deps, token, { code: right }), "too_many_attempts");
    expect((await getApprovalView(deps, token)).codeSentTo).toBeUndefined();

    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const { booking: approved } = await approveBooking(deps, token, { code: lastSentCode(deps) });
    expect(approved.status).toBe("confirmed");
  });

  it("the right code on the 5th attempt still works", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const right = lastSentCode(deps);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await failure(approveBooking(deps, token, { code: wrong }), "code_invalid");
    expect((await approveBooking(deps, token, { code: right })).booking.status).toBe("confirmed");
  });

  it("an expired code → code_expired (with a hold longer than the code's 10 minutes)", async () => {
    // Book's hold and the code both last 10 minutes, so to see a code expire before its hold, preload a
    // hold that lasts an hour.
    const token = newApprovalToken();
    deps = memoryDeps({
      clock,
      notifier,
      codeSender: codes,
      initialBookings: [
        {
          shopSlug: "harts",
          serviceId: "haircut",
          staffId: "dana",
          start: new Date(SAT_1400),
          end: new Date("2026-11-14T14:30:00-05:00"),
          customerName: "Maya",
          agentName: "Claude",
          status: "awaiting_approval",
          approveBy: new Date(NOW.getTime() + 60 * MIN),
          approvalTokenHash: sha256Hex(token),
        },
      ],
    });
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    clock.advance(10 * MIN);
    const err = await failure(approveBooking(deps, token, { code: lastSentCode(deps) }), "code_expired");
    expect(err.nextAction).toMatch(/new code/);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    expect((await approveBooking(deps, token, { code: lastSentCode(deps) })).booking.status).toBe("confirmed");
  });

  it("a new code replaces the previous one", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const first = lastSentCode(deps);
    let second = first;
    while (second === first) {
      await sendApprovalCode(deps, token, { phone: OTHER_PHONE_E164 });
      second = lastSentCode(deps);
    }
    await failure(approveBooking(deps, token, { code: first }), "code_invalid");
    const { booking: approved } = await approveBooking(deps, token, { code: second });
    expect(approved.customer.phoneLast4).toBe("0199");
  });

  it("a code works once: reusing it on the same link fails", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const code = lastSentCode(deps);
    await approveBooking(deps, token, { code });
    await failure(approveBooking(deps, token, { code }), "approval_closed");
    expect(store.consentRows().challenges.map((c) => c.consumedAt !== null)).toEqual([true]);
  });

  it("approving before any code was sent → code_invalid: get a code first", async () => {
    const booking = await hold();
    const err = await failure(approveBooking(deps, approvalToken(booking), { code: "123456" }), "code_invalid");
    expect(err.nextAction).toMatch(/phone number/);
  });

  it("a malformed code is invalid_request and isn't counted as an attempt", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    for (const body of [{ code: "12345" }, { code: "abcdef" }, { code: 123456 }, {}, null, "123456"]) {
      const err = await failure(approveBooking(deps, token, body), "invalid_request");
      expect(JSON.stringify(err.details)).not.toContain("12345");
    }
    expect(store.consentRows().challenges[0].attempts).toBe(0);
    expect((await approveBooking(deps, token, { code: ` ${lastSentCode(deps).slice(0, 3)} ${lastSentCode(deps).slice(3)} ` })).booking.status).toBe(
      "confirmed",
    );
  });

  it("a phone that isn't E.164 is invalid_request, and the number isn't echoed back", async () => {
    const booking = await hold();
    for (const phone of ["4015550123", "+0123", "call me", 14015550123]) {
      const err = await failure(sendApprovalCode(deps, approvalToken(booking), { phone }), "invalid_request");
      expect(err.details).toEqual({ field: "phone" });
    }
    expect(codes.sent).toHaveLength(0);
  });
});

describe("send limits", () => {
  it("3 codes per phone per hour, across links; another phone still works", async () => {
    const first = await hold(SAT_1400);
    const second = await hold(SAT_1500, { name: "Lee" });
    for (let i = 0; i < 3; i++) {
      await sendApprovalCode(deps, approvalToken(first), { phone: PHONE_E164 });
      clock.advance(MIN);
    }
    const err = await failure(sendApprovalCode(deps, approvalToken(second), { phone: PHONE_E164 }), "rate_limited");
    // The first send (at NOW) leaves the window at NOW + 1 hour; it's NOW + 3 minutes.
    expect(err.details).toEqual({ retryAfter: 57 * 60, limit: "phone" });
    expect(codes.sent).toHaveLength(3);
    await sendApprovalCode(deps, approvalToken(second), { phone: OTHER_PHONE_E164 });
    expect(codes.sent).toHaveLength(4);
  });

  it("10 codes per link per hour, whatever the phones", async () => {
    const booking = await hold();
    const token = approvalToken(booking);
    for (let i = 0; i < 10; i++) {
      await sendApprovalCode(deps, token, { phone: `+1401555${String(1000 + i)}` });
      clock.advance(10_000);
    }
    const err = await failure(sendApprovalCode(deps, token, { phone: "+14015552000" }), "rate_limited");
    expect(err.details).toEqual({ retryAfter: 3600 - 100, limit: "link" });
    expect(err.nextAction).toMatch(/last code/);
  });
});

describe("secrets stay out of the logs", () => {
  it("no token, code or full phone number is logged during the whole flow", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    deps = memoryDeps({ clock, notifier, codeSender: recordingCodeSender() });
    const booking = await hold();
    const token = approvalToken(booking);
    await sendApprovalCode(deps, token, { phone: PHONE_E164 });
    const code = lastSentCode(deps);
    await failure(approveBooking(deps, token, { code: code === "000000" ? "111111" : "000000" }), "code_invalid");
    await approveBooking(deps, token, { code });
    const logged = lines.join("\n");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain("4015550123");
  });
});
