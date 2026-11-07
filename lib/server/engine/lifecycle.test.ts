import { describe, expect, it } from "vitest";
import type { BookingStatus } from "../../types/frontdesk";
import { FrontDeskError } from "../frontdesk/errors";
import {
  APPROVAL_HOLD_MINUTES,
  decide,
  type BookDecision,
  type BookProposal,
  type Decision,
  type LifecycleAction,
  type LifecycleActor,
} from "./lifecycle";

// A fixed booking on Sat 14 Nov 2026 at 2:30 pm EST, a $15 deposit, and Hart's 24-hour cancel window.
const START = "2026-11-14T14:30:00-05:00";
const START_MS = new Date(START).getTime();
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(START_MS + offsetMs);

const WELL_BEFORE = at(-48 * HOUR);
const INSIDE_WINDOW = at(-2 * HOUR);
const AT_START = at(0);
const AFTER_START = at(1 * HOUR);
const ANY_TIME = [WELL_BEFORE, INSIDE_WINDOW, AT_START, AFTER_START];

const PHONE = "(555) 010-0199";
const POLICIES = { cancelWindowHours: 24, phone: PHONE };

const ALL_STATUSES: BookingStatus[] = [
  "awaiting_approval",
  "awaiting_deposit",
  "confirmed",
  "cancelled",
  "expired",
  "completed",
  "no_show",
];
const FINAL: BookingStatus[] = ["cancelled", "expired", "completed", "no_show"];
/** The agent and owner actions (the 1a table). */
const ALL_ACTIONS: LifecycleAction[] = ["cancel", "complete", "mark_no_show"];
const ALL_ACTORS: LifecycleActor[] = ["agent", "owner"];

/**
 * The hold's deadline in these tests: 3 days before the start, so "before approveBy" is WELL_BEFORE-ish
 * and every other time in ANY_TIME is after it.
 */
const APPROVE_BY = at(-72 * HOUR);
const BEFORE_APPROVE_BY = at(-72 * HOUR - 1);

function booking(status: BookingStatus, depositCents = 1500) {
  return { id: "3f1c8a52-6d0e-4b8f-9a77-2c5d1e9b0a41", status, start: START, depositCents, approveBy: APPROVE_BY };
}

/** A decision as-is, or just the error code, for compact expectations. */
type Outcome = Decision | { error: string };

function outcome(result: Decision | FrontDeskError): Outcome {
  return result instanceof FrontDeskError ? { error: result.code } : result;
}

function expectError(result: Decision | BookDecision | FrontDeskError, code: string): FrontDeskError {
  expect(result).toBeInstanceOf(FrontDeskError);
  const err = result as FrontDeskError;
  expect(err.code).toBe(code);
  return err;
}

type Row = {
  label: string;
  actor: LifecycleActor;
  actions: LifecycleAction[];
  statuses: BookingStatus[];
  nows: Date[];
  expected: Outcome;
};

// One entry per row of the table in decide()'s doc comment, in the same order. A row that covers
// several actions, statuses or times checks every combination.
const TABLE: Row[] = [
  {
    label: "agent | cancel | confirmed | start − now >= cancelWindowHours → cancelled, released",
    actor: "agent",
    actions: ["cancel"],
    statuses: ["confirmed"],
    nows: [WELL_BEFORE, at(-24 * HOUR)],
    expected: { nextStatus: "cancelled", depositEffect: "released" },
  },
  {
    label: "agent | cancel | confirmed | before start, inside the window → cancelled, captured",
    actor: "agent",
    actions: ["cancel"],
    statuses: ["confirmed"],
    nows: [at(-24 * HOUR + 1), INSIDE_WINDOW, at(-1)],
    expected: { nextStatus: "cancelled", depositEffect: "captured" },
  },
  {
    label: "agent | cancel | confirmed | after start → not_cancellable",
    actor: "agent",
    actions: ["cancel"],
    statuses: ["confirmed"],
    nows: [AT_START, AFTER_START],
    expected: { error: "not_cancellable" },
  },
  {
    label: "agent | cancel | awaiting_approval / awaiting_deposit | any time → cancelled, released",
    actor: "agent",
    actions: ["cancel"],
    statuses: ["awaiting_approval", "awaiting_deposit"],
    nows: [BEFORE_APPROVE_BY, ...ANY_TIME],
    expected: { nextStatus: "cancelled", depositEffect: "released" },
  },
  {
    label: "owner | cancel | awaiting_approval | any time → cancelled, released",
    actor: "owner",
    actions: ["cancel"],
    statuses: ["awaiting_approval"],
    nows: [BEFORE_APPROVE_BY, ...ANY_TIME],
    expected: { nextStatus: "cancelled", depositEffect: "released" },
  },
  {
    label: "owner | cancel | awaiting_deposit/confirmed | before start → cancelled, released",
    actor: "owner",
    actions: ["cancel"],
    statuses: ["awaiting_deposit", "confirmed"],
    nows: [WELL_BEFORE, INSIDE_WINDOW, at(-1)],
    expected: { nextStatus: "cancelled", depositEffect: "released" },
  },
  {
    label: "owner | cancel | awaiting_deposit/confirmed | after start → invalid_request",
    actor: "owner",
    actions: ["cancel"],
    statuses: ["awaiting_deposit", "confirmed"],
    nows: [AT_START, AFTER_START],
    expected: { error: "invalid_request" },
  },
  {
    label: "owner | complete | confirmed | after start → completed, released",
    actor: "owner",
    actions: ["complete"],
    statuses: ["confirmed"],
    nows: [AT_START, AFTER_START],
    expected: { nextStatus: "completed", depositEffect: "released" },
  },
  {
    label: "owner | mark_no_show | confirmed | after start → no_show, captured",
    actor: "owner",
    actions: ["mark_no_show"],
    statuses: ["confirmed"],
    nows: [AT_START, AFTER_START],
    expected: { nextStatus: "no_show", depositEffect: "captured" },
  },
  {
    label: "owner | complete / mark_no_show | confirmed | before start → invalid_request",
    actor: "owner",
    actions: ["complete", "mark_no_show"],
    statuses: ["confirmed"],
    nows: [WELL_BEFORE, INSIDE_WINDOW, at(-1)],
    expected: { error: "invalid_request" },
  },
  {
    label: "owner | complete / mark_no_show | awaiting_approval / awaiting_deposit | any time → invalid_request",
    actor: "owner",
    actions: ["complete", "mark_no_show"],
    statuses: ["awaiting_approval", "awaiting_deposit"],
    nows: ANY_TIME,
    expected: { error: "invalid_request" },
  },
  {
    // An agent's only action is cancel; complete / mark_no_show from any status is the last row.
    label: "agent | any | cancelled/expired/completed/no_show | any time → not_cancellable",
    actor: "agent",
    actions: ["cancel"],
    statuses: FINAL,
    nows: ANY_TIME,
    expected: { error: "not_cancellable" },
  },
  {
    label: "owner | any | cancelled/expired/completed/no_show | any time → invalid_request",
    actor: "owner",
    actions: ALL_ACTIONS,
    statuses: FINAL,
    nows: ANY_TIME,
    expected: { error: "invalid_request" },
  },
  {
    label: "agent | complete / mark_no_show | any | any time → invalid_request",
    actor: "agent",
    actions: ["complete", "mark_no_show"],
    statuses: ALL_STATUSES,
    nows: ANY_TIME,
    expected: { error: "invalid_request" },
  },
];

/** Every allowed transition, as [label, status, actor, action, now, nextStatus]. */
const ALLOWED: [string, BookingStatus, LifecycleActor, LifecycleAction, Date, BookingStatus][] = [
  ["agent cancels confirmed outside the window", "confirmed", "agent", "cancel", WELL_BEFORE, "cancelled"],
  ["agent cancels confirmed inside the window", "confirmed", "agent", "cancel", INSIDE_WINDOW, "cancelled"],
  ["agent cancels awaiting_deposit", "awaiting_deposit", "agent", "cancel", AFTER_START, "cancelled"],
  ["agent cancels awaiting_approval", "awaiting_approval", "agent", "cancel", BEFORE_APPROVE_BY, "cancelled"],
  ["owner cancels awaiting_approval", "awaiting_approval", "owner", "cancel", AFTER_START, "cancelled"],
  ["customer approves awaiting_approval", "awaiting_approval", "customer", "approve", BEFORE_APPROVE_BY, "confirmed"],
  ["customer declines awaiting_approval", "awaiting_approval", "customer", "decline", BEFORE_APPROVE_BY, "cancelled"],
  ["system expires a lapsed hold", "awaiting_approval", "system", "expire", APPROVE_BY, "expired"],
  ["owner cancels awaiting_deposit", "awaiting_deposit", "owner", "cancel", INSIDE_WINDOW, "cancelled"],
  ["owner cancels confirmed", "confirmed", "owner", "cancel", INSIDE_WINDOW, "cancelled"],
  ["owner completes confirmed", "confirmed", "owner", "complete", AFTER_START, "completed"],
  ["owner marks confirmed a no-show", "confirmed", "owner", "mark_no_show", AFTER_START, "no_show"],
];

/** Every combination of status, actor, action and time that decide() can be asked about. */
function everyCombination() {
  const combos: { status: BookingStatus; actor: LifecycleActor; type: LifecycleAction; now: Date }[] = [];
  for (const status of ALL_STATUSES) {
    for (const actor of ALL_ACTORS) {
      for (const type of ALL_ACTIONS) {
        for (const now of ANY_TIME) combos.push({ status, actor, type, now });
      }
    }
  }
  return combos;
}

describe("decide: the transition table", () => {
  it.each(TABLE)("$label", ({ actor, actions, statuses, nows, expected }) => {
    for (const status of statuses) {
      for (const type of actions) {
        for (const now of nows) {
          const result = decide(booking(status), { type, actor }, now, POLICIES);
          expect(outcome(result), `${actor} ${type} ${status} at ${now.toISOString()}`).toEqual(expected);
        }
      }
    }
  });
});

describe("decide: deposits", () => {
  it.each(ALLOWED)("depositCents 0 → depositEffect none: %s", (_label, status, actor, type, now, nextStatus) => {
    expect(decide(booking(status, 0), { type, actor }, now, POLICIES)).toEqual({ nextStatus, depositEffect: "none" });
  });

  it("an agent cancel exactly cancelWindowHours before the start → released", () => {
    expect(decide(booking("confirmed"), { type: "cancel", actor: "agent" }, at(-24 * HOUR), POLICIES)).toEqual({
      nextStatus: "cancelled",
      depositEffect: "released",
    });
  });

  it("an agent cancel 1 ms inside the window → captured", () => {
    expect(decide(booking("confirmed"), { type: "cancel", actor: "agent" }, at(-24 * HOUR + 1), POLICIES)).toEqual({
      nextStatus: "cancelled",
      depositEffect: "captured",
    });
  });

  it("cancelWindowHours 0: an agent cancel 1 minute before the start → released", () => {
    const result = decide(booking("confirmed"), { type: "cancel", actor: "agent" }, at(-60 * 1000), {
      ...POLICIES,
      cancelWindowHours: 0,
    });
    expect(result).toEqual({ nextStatus: "cancelled", depositEffect: "released" });
  });
});

describe("decide: now === start counts as after the start", () => {
  it("agent cancel → not_cancellable, with the start in details", () => {
    const err = expectError(decide(booking("confirmed"), { type: "cancel", actor: "agent" }, AT_START, POLICIES), "not_cancellable");
    expect(err.message).toBe("This appointment has already started.");
    expect(err.details).toEqual({ status: "confirmed", booking_id: booking("confirmed").id, start: START });
  });

  it("complete → completed", () => {
    expect(decide(booking("confirmed"), { type: "complete", actor: "owner" }, AT_START, POLICIES)).toEqual({
      nextStatus: "completed",
      depositEffect: "released",
    });
  });

  it("mark_no_show → no_show", () => {
    expect(decide(booking("confirmed"), { type: "mark_no_show", actor: "owner" }, AT_START, POLICIES)).toEqual({
      nextStatus: "no_show",
      depositEffect: "captured",
    });
  });

  it("owner cancel → invalid_request", () => {
    const err = expectError(decide(booking("confirmed"), { type: "cancel", actor: "owner" }, AT_START, POLICIES), "invalid_request");
    expect(err.message).toBe("You can only cancel a booking before its start time.");
    expect(err.nextAction).toBe("Mark it completed or a no-show instead.");
  });
});

describe("decide: errors", () => {
  it("every error has a next_action and the right details, in plain words", () => {
    let errors = 0;
    for (const { status, actor, type, now } of everyCombination()) {
      const b = booking(status);
      const result = decide(b, { type, actor }, now, POLICIES);
      if (!(result instanceof FrontDeskError)) continue;
      errors++;
      const where = `${actor} ${type} ${status} at ${now.toISOString()}`;
      expect(result.nextAction.trim(), where).not.toBe("");
      expect(result.message.trim(), where).not.toBe("");
      // Statuses and actions are written as words ("no-show", "awaiting deposit"), never as identifiers.
      expect(result.message, where).not.toMatch(/_/);
      expect(result.nextAction, where).not.toMatch(/_/);
      if (result.code === "not_cancellable") {
        const startPassed = status === "confirmed" && now.getTime() >= START_MS;
        expect(result.details, where).toEqual(
          startPassed ? { status, booking_id: b.id, start: START } : { status, booking_id: b.id },
        );
      } else {
        expect(result.code, where).toBe("invalid_request");
        expect(result.details, where).toEqual({ status, action: type, booking_id: b.id });
      }
    }
    expect(errors).toBeGreaterThan(0);
  });

  it.each<[string, BookingStatus, LifecycleActor, LifecycleAction, Date, string]>([
    ["agent cancels a cancelled booking", "cancelled", "agent", "cancel", WELL_BEFORE, "This booking is already cancelled."],
    ["agent cancels an expired booking", "expired", "agent", "cancel", WELL_BEFORE, "This booking has already expired."],
    ["agent cancels a no-show", "no_show", "agent", "cancel", AFTER_START, "This booking is already marked as a no-show."],
    ["agent cancels after the start", "confirmed", "agent", "cancel", AFTER_START, "This appointment has already started."],
    ["owner cancels a completed booking", "completed", "owner", "cancel", AFTER_START, "A completed booking can't be cancelled."],
    ["owner cancels a cancelled booking", "cancelled", "owner", "cancel", WELL_BEFORE, "This booking is already cancelled."],
    ["owner completes a no-show", "no_show", "owner", "complete", AFTER_START, "A booking marked as a no-show can't be marked completed."],
    ["owner completes before the start", "confirmed", "owner", "complete", INSIDE_WINDOW, "You can only mark a booking completed after its start time."],
    ["owner marks a no-show before the start", "confirmed", "owner", "mark_no_show", INSIDE_WINDOW, "You can only mark a booking as a no-show after its start time."],
    ["owner completes awaiting deposit", "awaiting_deposit", "owner", "complete", AFTER_START, "A booking awaiting deposit can't be marked completed."],
    ["owner completes awaiting approval", "awaiting_approval", "owner", "complete", AFTER_START, "A booking awaiting approval can't be marked completed."],
    ["owner marks awaiting approval a no-show", "awaiting_approval", "owner", "mark_no_show", AFTER_START, "A booking awaiting approval can't be marked as a no-show."],
    ["agent completes", "confirmed", "agent", "complete", AFTER_START, "Only the shop can mark a booking completed or a no-show."],
    ["agent marks a no-show", "confirmed", "agent", "mark_no_show", AFTER_START, "Only the shop can mark a booking completed or a no-show."],
  ])("message: %s", (_label, status, actor, type, now, message) => {
    const result = decide(booking(status), { type, actor }, now, POLICIES);
    expect(result).toBeInstanceOf(FrontDeskError);
    expect((result as FrontDeskError).message).toBe(message);
  });

  it("not_cancellable's next_action includes the shop's phone when it's set", () => {
    const err = expectError(decide(booking("cancelled"), { type: "cancel", actor: "agent" }, WELL_BEFORE, POLICIES), "not_cancellable");
    expect(err.nextAction).toBe(`Don't retry. If the person still needs to change it, tell them to call the shop at ${PHONE}.`);
  });

  it("not_cancellable's next_action still reads well when the phone is null", () => {
    const err = expectError(
      decide(booking("confirmed"), { type: "cancel", actor: "agent" }, AFTER_START, { ...POLICIES, phone: null }),
      "not_cancellable",
    );
    expect(err.nextAction).toBe("Don't retry. If the person still needs to change it, tell them to call the shop.");
  });
});

describe("decide: purity", () => {
  it("the same inputs give the same output", () => {
    for (const { status, actor, type, now } of everyCombination()) {
      const first = decide(booking(status), { type, actor }, now, POLICIES);
      const second = decide(booking(status), { type, actor }, now, POLICIES);
      if (first instanceof FrontDeskError) {
        expect(second).toBeInstanceOf(FrontDeskError);
        const err = second as FrontDeskError;
        expect([err.code, err.message, err.nextAction, err.details]).toEqual([
          first.code,
          first.message,
          first.nextAction,
          first.details,
        ]);
      } else {
        expect(second).toEqual(first);
      }
    }
  });

  it("doesn't mutate the booking, the clock value or the policies", () => {
    const b = Object.freeze(booking("confirmed"));
    const policies = Object.freeze({ ...POLICIES });
    const now = new Date(INSIDE_WINDOW.getTime());
    const result = decide(b, { type: "cancel", actor: "agent" }, now, policies);
    expect(result).toEqual({ nextStatus: "cancelled", depositEffect: "captured" });
    expect(b).toEqual(booking("confirmed"));
    expect(policies).toEqual(POLICIES);
    expect(now.getTime()).toBe(INSIDE_WINDOW.getTime());
  });

  it("throws a plain Error (a bug, not a caller mistake) when booking.start isn't RFC 3339", () => {
    const bad = { ...booking("confirmed"), start: "2026-11-14 14:30" };
    expect(() => decide(bad, { type: "cancel", actor: "agent" }, WELL_BEFORE, POLICIES)).toThrow(/isn't RFC 3339/);
    try {
      decide(bad, { type: "cancel", actor: "agent" }, WELL_BEFORE, POLICIES);
    } catch (err) {
      expect(err).not.toBeInstanceOf(FrontDeskError);
    }
  });
});

// ---- Ring 1b: holds, the person's answer, expiry, and the book action ----

const NOT_PENDING: BookingStatus[] = ["awaiting_deposit", "confirmed", "cancelled", "completed", "no_show"];

describe("decide: the person approves or declines (actor customer)", () => {
  it("approve before approveBy → confirmed, deposit none (Ring 1c adds awaiting_deposit)", () => {
    for (const depositCents of [0, 1500]) {
      expect(decide(booking("awaiting_approval", depositCents), { type: "approve", actor: "customer" }, BEFORE_APPROVE_BY, POLICIES)).toEqual({
        nextStatus: "confirmed",
        depositEffect: "none",
      });
    }
  });

  it("decline before approveBy → cancelled, deposit released (none without a deposit)", () => {
    expect(decide(booking("awaiting_approval"), { type: "decline", actor: "customer" }, BEFORE_APPROVE_BY, POLICIES)).toEqual({
      nextStatus: "cancelled",
      depositEffect: "released",
    });
    expect(decide(booking("awaiting_approval", 0), { type: "decline", actor: "customer" }, BEFORE_APPROVE_BY, POLICIES)).toEqual({
      nextStatus: "cancelled",
      depositEffect: "none",
    });
  });

  it.each(["approve", "decline"] as const)("%s at or after approveBy (a stale hold) → approval_expired", (type) => {
    for (const now of [APPROVE_BY, at(-72 * HOUR + 1), ...ANY_TIME]) {
      const err = expectError(decide(booking("awaiting_approval"), { type, actor: "customer" }, now, POLICIES), "approval_expired");
      expect(err.nextAction).toBe("Ask your agent to book again.");
      expect(err.details).toEqual({ status: "awaiting_approval", booking_id: booking("awaiting_approval").id });
    }
  });

  it.each(["approve", "decline"] as const)("%s of an expired booking → approval_expired", (type) => {
    const err = expectError(decide(booking("expired"), { type, actor: "customer" }, BEFORE_APPROVE_BY, POLICIES), "approval_expired");
    expect(err.nextAction).toBe("Ask your agent to book again.");
  });

  it.each(["approve", "decline"] as const)("%s of a booking that isn't awaiting approval → approval_closed", (type) => {
    for (const status of NOT_PENDING) {
      const err = expectError(decide(booking(status), { type, actor: "customer" }, BEFORE_APPROVE_BY, POLICIES), "approval_closed");
      expect(err.details).toEqual({ status, booking_id: booking(status).id });
      expect(err.message).not.toMatch(/_/);
      expect(err.nextAction.trim()).not.toBe("");
    }
  });

  it("throws a plain Error when an awaiting_approval booking has no approveBy (a bug)", () => {
    const noDeadline = { ...booking("awaiting_approval"), approveBy: null };
    expect(() => decide(noDeadline, { type: "approve", actor: "customer" }, BEFORE_APPROVE_BY, POLICIES)).toThrow(/no approveBy/);
  });
});

describe("decide: a lapsed hold expires (actor system)", () => {
  it("at or after approveBy → expired, deposit released (none without a deposit)", () => {
    for (const now of [APPROVE_BY, ...ANY_TIME]) {
      expect(decide(booking("awaiting_approval"), { type: "expire", actor: "system" }, now, POLICIES)).toEqual({
        nextStatus: "expired",
        depositEffect: "released",
      });
    }
    expect(decide(booking("awaiting_approval", 0), { type: "expire", actor: "system" }, APPROVE_BY, POLICIES)).toEqual({
      nextStatus: "expired",
      depositEffect: "none",
    });
  });

  it("before approveBy → invalid_request: the hold is still on", () => {
    const err = expectError(decide(booking("awaiting_approval"), { type: "expire", actor: "system" }, BEFORE_APPROVE_BY, POLICIES), "invalid_request");
    expect(err.details).toEqual({ status: "awaiting_approval", action: "expire", booking_id: booking("awaiting_approval").id });
  });

  it("any other status → invalid_request: only a hold expires", () => {
    for (const status of ALL_STATUSES.filter((s) => s !== "awaiting_approval")) {
      expectError(decide(booking(status), { type: "expire", actor: "system" }, AFTER_START, POLICIES), "invalid_request");
    }
  });
});

describe("decide: each actor may take only its own actions", () => {
  const EVERY_ACTION: LifecycleAction[] = ["cancel", "complete", "mark_no_show", "approve", "decline", "expire"];
  const OWN: Record<LifecycleActor, LifecycleAction[]> = {
    agent: ["cancel"],
    owner: ["cancel", "complete", "mark_no_show"],
    customer: ["approve", "decline"],
    system: ["expire"],
  };

  it("anything else is invalid_request, whatever the status and time, with plain words and a next_action", () => {
    let checked = 0;
    for (const actor of Object.keys(OWN) as LifecycleActor[]) {
      for (const type of EVERY_ACTION.filter((a) => !OWN[actor].includes(a))) {
        for (const status of ALL_STATUSES) {
          for (const now of [BEFORE_APPROVE_BY, ...ANY_TIME]) {
            const where = `${actor} ${type} ${status} at ${now.toISOString()}`;
            const result = decide(booking(status), { type, actor }, now, POLICIES);
            const err = expectError(result, "invalid_request");
            expect(err.details, where).toEqual({ status, action: type, booking_id: booking(status).id });
            expect(err.message, where).not.toMatch(/_/);
            expect(err.nextAction, where).not.toMatch(/_/);
            expect(err.nextAction.trim(), where).not.toBe("");
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("decide: the book action (mandate and hold)", () => {
  const NOW = new Date("2026-11-09T12:00:00-05:00");
  const proposal = (mandate: BookProposal["mandate"] = null): BookProposal => ({
    priceCents: 3500,
    depositCents: 1000,
    start: new Date(START),
    end: new Date(START_MS + 30 * 60 * 1000),
    mandate,
  });
  const book = (p: BookProposal) => decide(p, { type: "book", actor: "agent" }, NOW);
  const NEXT = "Ask the person to widen their limit, or choose a different service or time.";

  it(`without a mandate → awaiting_approval, held for ${APPROVAL_HOLD_MINUTES} minutes`, () => {
    expect(book(proposal())).toEqual({ nextStatus: "awaiting_approval", approveBy: new Date(NOW.getTime() + 10 * 60 * 1000) });
  });

  it("within every limit (each one exactly at the limit) → awaiting_approval", () => {
    const result = book(
      proposal({
        priceCapCents: 3500,
        depositCapCents: 1000,
        window: { from: START, to: "2026-11-14T15:00:00-05:00" },
      }),
    );
    expect(result).toEqual({ nextStatus: "awaiting_approval", approveBy: new Date(NOW.getTime() + 10 * 60 * 1000) });
  });

  it("price over priceCapCents → outside_mandate, field price_cap", () => {
    const err = expectError(book(proposal({ priceCapCents: 3499 })), "outside_mandate");
    expect(err.details).toEqual({ field: "price_cap", priceCents: 3500, priceCapCents: 3499 });
    expect(err.nextAction).toBe(NEXT);
    expect(err.message).toBe("This service costs $35.00, more than the person's limit of $34.99.");
  });

  it("deposit over depositCapCents → outside_mandate, field deposit_cap", () => {
    const err = expectError(book(proposal({ depositCapCents: 0 })), "outside_mandate");
    expect(err.details).toEqual({ field: "deposit_cap", depositCents: 1000, depositCapCents: 0 });
    expect(err.nextAction).toBe(NEXT);
  });

  it("starting before the window or ending after it → outside_mandate, field window", () => {
    const before = expectError(book(proposal({ window: { from: "2026-11-14T14:31:00-05:00", to: "2026-11-14T18:00:00-05:00" } })), "outside_mandate");
    expect(before.details).toMatchObject({ field: "window", window: { from: "2026-11-14T14:31:00-05:00", to: "2026-11-14T18:00:00-05:00" } });
    const after = expectError(book(proposal({ window: { from: "2026-11-14T09:00:00-05:00", to: "2026-11-14T14:59:00-05:00" } })), "outside_mandate");
    expect(after.details).toMatchObject({ field: "window" });
    expect(after.nextAction).toBe(NEXT);
  });

  it("compares the window as instants, whatever offsets it's written in", () => {
    // 19:30Z is 14:30 EST: the appointment starts exactly at from.
    expect(book(proposal({ window: { from: "2026-11-14T19:30:00Z", to: "2026-11-14T20:00:00Z" } }))).toMatchObject({
      nextStatus: "awaiting_approval",
    });
  });

  it("reports the first broken limit in order: price, then deposit, then window", () => {
    const all = { priceCapCents: 1, depositCapCents: 1, window: { from: "2030-01-01T00:00:00Z", to: "2030-01-02T00:00:00Z" } };
    expect(expectError(book(proposal(all)), "outside_mandate").details?.field).toBe("price_cap");
    expect(expectError(book(proposal({ ...all, priceCapCents: undefined })), "outside_mandate").details?.field).toBe("deposit_cap");
    expect(expectError(book(proposal({ window: all.window })), "outside_mandate").details?.field).toBe("window");
  });

  it("is pure: the same inputs give the same output and nothing is mutated", () => {
    const p = Object.freeze(proposal(Object.freeze({ priceCapCents: 5000 })));
    expect(book(p)).toEqual(book(p));
    expect(p.mandate).toEqual({ priceCapCents: 5000 });
  });
});
