import type { Booking, BookingStatus, DepositEffect, Mandate, Policies } from "../../types/frontdesk";
import { FrontDeskError } from "../frontdesk/errors";
import { parseRfc3339 } from "../frontdesk/time";

// Pure booking lifecycle: given a booking, an action, the time and the shop's policies, decide the
// next status and what happens to the deposit. No I/O, no clock reads.
//
// TODO(ring-1c): move real money. Today every caller reports the depositEffect decided here with
// depositCollected: false.

/**
 * What can be done to an existing booking. Agents may only cancel; owners may cancel, complete and
 * mark a no-show; the person (actor "customer") approves or declines; "system" expires a lapsed hold.
 * Placing a booking is the "book" action, decided by the first overload of decide().
 */
export type LifecycleAction = "cancel" | "complete" | "mark_no_show" | "approve" | "decline" | "expire";

/** The actions an agent or the owner takes on a booking (the cancel tool and the owner routes). */
export type ManageAction = "cancel" | "complete" | "mark_no_show";

/** Who is acting. "customer" is the person answering through the approval link. */
export type LifecycleActor = "agent" | "owner" | "customer" | "system";

export type Decision = {
  nextStatus: BookingStatus;
  depositEffect: DepositEffect;
};

/** How long book holds a slot for the person to approve it. */
export const APPROVAL_HOLD_MINUTES = 10;
const APPROVAL_HOLD_MS = APPROVAL_HOLD_MINUTES * 60 * 1000;

/** What decide() needs to know about a booking it doesn't create. */
export type DecideBooking = Pick<Booking, "id" | "status" | "start" | "depositCents"> & {
  /** When the hold lapses. Needed for approve, decline and expire on an awaiting_approval booking. */
  approveBy?: Date | null;
};

/** What decide() needs to know about a booking book is about to place. */
export type BookProposal = {
  /** The service's price, in integer cents. */
  priceCents: number;
  /** The service's deposit, in integer cents. */
  depositCents: number;
  /** The appointment, [start, end). */
  start: Date;
  end: Date;
  /** The person's limits, already validated (see parseMandate in service.ts). null: none. */
  mandate: Mandate | null;
};

/** What book does when decide() allows it: hold the slot until approveBy. */
export type BookDecision = {
  nextStatus: "awaiting_approval";
  /** now + APPROVAL_HOLD_MINUTES. */
  approveBy: Date;
};

type DecidePolicies = Pick<Policies, "cancelWindowHours" | "phone">;

/** Statuses a booking never leaves. */
type FinalStatus = "cancelled" | "expired" | "completed" | "no_show";

const MS_PER_HOUR = 60 * 60 * 1000;

const FINAL_STATUSES: ReadonlySet<BookingStatus> = new Set<FinalStatus>(["cancelled", "expired", "completed", "no_show"]);

/** The status each owner/agent action moves a booking to when it's allowed. */
const TARGET_STATUS: Record<"cancel" | "complete" | "mark_no_show", BookingStatus> = {
  cancel: "cancelled",
  complete: "completed",
  mark_no_show: "no_show",
};

/** "This booking is already …", for a final status. */
const ALREADY: Record<FinalStatus, string> = {
  cancelled: "This booking is already cancelled.",
  expired: "This booking has already expired.",
  completed: "This booking is already completed.",
  no_show: "This booking is already marked as a no-show.",
};

/** The booking described by its status, to start a sentence: "A completed booking …". */
const BOOKING_IN: Record<BookingStatus, string> = {
  awaiting_approval: "A booking awaiting approval",
  awaiting_deposit: "A booking awaiting deposit",
  confirmed: "A confirmed booking",
  cancelled: "A cancelled booking",
  expired: "An expired booking",
  completed: "A completed booking",
  no_show: "A booking marked as a no-show",
};

/** What the action does to a booking, after "can't be": "… can't be marked completed." */
const ACTION_DONE: Record<LifecycleAction, string> = {
  cancel: "cancelled",
  complete: "marked completed",
  mark_no_show: "marked as a no-show",
  approve: "approved",
  decline: "declined",
  expire: "expired",
};

/** The actions each actor may take. */
const ACTOR_ACTIONS: Record<LifecycleActor, readonly LifecycleAction[]> = {
  agent: ["cancel"],
  owner: ["cancel", "complete", "mark_no_show"],
  customer: ["approve", "decline"],
  system: ["expire"],
};

const OWNER_FINAL_NEXT = "Don't retry: this booking is final and can't change any more. Reload it to see its current status and history.";
const OWNER_LEAVE_AWAITING =
  "Leave it as it is: a booking awaiting deposit expires on its own if the deposit isn't paid in time.";
const OWNER_ONLY_CONFIRMED = "Only a confirmed booking can be marked completed or a no-show.";
const OWNER_NOT_APPROVED = "The person hasn't approved this booking yet; cancel it if it isn't going ahead.";

const APPROVAL_EXPIRED_NEXT = "Ask your agent to book again.";
const APPROVAL_CLOSED_NEXT = "Nothing more to do with this link. Ask your agent if you need a new booking.";

export const OUTSIDE_MANDATE_NEXT = "Ask the person to widen their limit, or choose a different service or time.";

function isFinal(status: BookingStatus): status is FinalStatus {
  return FINAL_STATUSES.has(status);
}

/** The policy's deposit effect, or "none" when the booking has no deposit. */
function depositEffect(booking: Pick<DecideBooking, "depositCents">, effect: "released" | "captured"): DepositEffect {
  return booking.depositCents > 0 ? effect : "none";
}

/** An agent may not do this; tell it to send the person to the shop. */
function notCancellable(
  booking: DecideBooking,
  message: string,
  phone: string | null,
  extra: Record<string, unknown> = {},
): FrontDeskError {
  const number = phone?.trim();
  return new FrontDeskError(
    "not_cancellable",
    message,
    `Don't retry. If the person still needs to change it, tell them to call the shop${number ? ` at ${number}` : ""}.`,
    { status: booking.status, booking_id: booking.id, ...extra },
  );
}

/** The booking's state doesn't allow this action, or this actor may not take it. */
function invalidAction(booking: DecideBooking, action: LifecycleAction, message: string, nextAction: string): FrontDeskError {
  return new FrontDeskError("invalid_request", message, nextAction, {
    status: booking.status,
    action,
    booking_id: booking.id,
  });
}

/** An owner action on a final booking. */
function ownerOnFinal(booking: DecideBooking, status: FinalStatus, action: "cancel" | "complete" | "mark_no_show"): FrontDeskError {
  const message =
    TARGET_STATUS[action] === status ? ALREADY[status] : `${BOOKING_IN[status]} can't be ${ACTION_DONE[action]}.`;
  return invalidAction(booking, action, message, OWNER_FINAL_NEXT);
}

/** An actor asked for an action that isn't theirs to take. */
function notYourAction(booking: DecideBooking, type: LifecycleAction, actor: LifecycleActor): FrontDeskError {
  if (actor === "agent" && (type === "complete" || type === "mark_no_show")) {
    return invalidAction(
      booking,
      type,
      "Only the shop can mark a booking completed or a no-show.",
      "Don't retry: agents can only cancel a booking. The shop records completed appointments and no-shows itself.",
    );
  }
  if (type === "approve" || type === "decline") {
    return invalidAction(
      booking,
      type,
      "Only the person the booking is for can approve or decline it, through the approval link.",
      "Send the person the approval link that book returned.",
    );
  }
  if (type === "expire") {
    return invalidAction(
      booking,
      type,
      "Holds expire on their own once their time runs out.",
      "Don't retry. Cancel the booking instead if it isn't going ahead.",
    );
  }
  return invalidAction(
    booking,
    type,
    `This booking can't be ${ACTION_DONE[type]} from the approval link.`,
    "Don't retry. Approve or decline the booking, or ask the shop to change it.",
  );
}

/** The hold's deadline, which an awaiting_approval booking must have. */
function holdDeadline(booking: DecideBooking): Date {
  if (!booking.approveBy) throw new Error(`Booking ${booking.id} is awaiting approval but has no approveBy.`);
  return booking.approveBy;
}

/** The person approving or declining: only while the hold is on. */
function decideAnswer(booking: DecideBooking, type: "approve" | "decline", now: Date): Decision | FrontDeskError {
  const lapsed =
    booking.status === "expired" ||
    (booking.status === "awaiting_approval" && now.getTime() >= holdDeadline(booking).getTime());
  if (lapsed) {
    return new FrontDeskError(
      "approval_expired",
      "The hold on this time ran out before it was approved, so the time is free again.",
      APPROVAL_EXPIRED_NEXT,
      { status: booking.status, booking_id: booking.id },
    );
  }
  if (booking.status !== "awaiting_approval") {
    return new FrontDeskError(
      "approval_closed",
      `${BOOKING_IN[booking.status]} can't be ${ACTION_DONE[type]}: this request is already closed.`,
      APPROVAL_CLOSED_NEXT,
      { status: booking.status, booking_id: booking.id },
    );
  }
  return type === "approve"
    ? // TODO(ring-1c): go to awaiting_deposit instead when depositCents > 0, and confirm once it's paid.
      { nextStatus: "confirmed", depositEffect: "none" }
    : { nextStatus: "cancelled", depositEffect: depositEffect(booking, "released") };
}

/** A lapsed hold expiring. The stores' lazy expiry (expireStaleHolds, refreshBooking) applies this same rule in SQL. */
function decideExpire(booking: DecideBooking, now: Date): Decision | FrontDeskError {
  if (booking.status !== "awaiting_approval") {
    return invalidAction(booking, "expire", `${BOOKING_IN[booking.status]} can't be expired.`, "Don't retry: only a hold expires.");
  }
  if (now.getTime() < holdDeadline(booking).getTime()) {
    return invalidAction(booking, "expire", "The hold hasn't run out yet.", "Wait until the hold runs out.");
  }
  return { nextStatus: "expired", depositEffect: depositEffect(booking, "released") };
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function outsideMandate(
  field: "price_cap" | "deposit_cap" | "window",
  message: string,
  details: Record<string, unknown>,
): FrontDeskError {
  return new FrontDeskError("outside_mandate", message, OUTSIDE_MANDATE_NEXT, { field, ...details });
}

/** The "book" row: check the mandate, then hold the slot for APPROVAL_HOLD_MINUTES. */
function decideBook(proposal: BookProposal, now: Date): BookDecision | FrontDeskError {
  const { mandate, priceCents, depositCents, start, end } = proposal;
  if (mandate?.priceCapCents !== undefined && priceCents > mandate.priceCapCents) {
    return outsideMandate(
      "price_cap",
      `This service costs ${usd(priceCents)}, more than the person's limit of ${usd(mandate.priceCapCents)}.`,
      { priceCents, priceCapCents: mandate.priceCapCents },
    );
  }
  if (mandate?.depositCapCents !== undefined && depositCents > mandate.depositCapCents) {
    return outsideMandate(
      "deposit_cap",
      `This service needs a ${usd(depositCents)} deposit, more than the person's limit of ${usd(mandate.depositCapCents)}.`,
      { depositCents, depositCapCents: mandate.depositCapCents },
    );
  }
  if (mandate?.window) {
    const from = parseRfc3339(mandate.window.from);
    const to = parseRfc3339(mandate.window.to);
    if (!from || !to) throw new Error("decide() was given a mandate window that isn't RFC 3339.");
    if (start.getTime() < from.getTime() || end.getTime() > to.getTime()) {
      return outsideMandate(
        "window",
        `That appointment isn't inside the times the person allowed (${mandate.window.from} to ${mandate.window.to}).`,
        { window: { ...mandate.window }, start: start.toISOString(), end: end.toISOString() },
      );
    }
  }
  return { nextStatus: "awaiting_approval", approveBy: new Date(now.getTime() + APPROVAL_HOLD_MS) };
}

/**
 * The "book" action: may the agent place this booking? Checks the person's mandate, in this order:
 * the service's price ≤ priceCapCents, its deposit ≤ depositCapCents, and [start, end) inside window.
 * The first one broken is `outside_mandate` (details.field "price_cap", "deposit_cap" or "window").
 * Otherwise the booking is held: { nextStatus: "awaiting_approval", approveBy: now + 10 minutes }.
 * TODO(ring-2): require a mandate once agents sign in.
 */
export function decide(proposal: BookProposal, action: { type: "book"; actor: "agent" }, now: Date): BookDecision | FrontDeskError;
/**
 * The transition table for an existing booking (`start` is the booking's start; "before start" means
 * now < start; "after start" means now >= start; "before approveBy" means now < approveBy):
 *
 * | actor    | action       | from                       | when                                 | → status  | deposit  |
 * |----------|--------------|----------------------------|--------------------------------------|-----------|----------|
 * | customer | approve      | awaiting_approval          | before approveBy                     | confirmed | none     |
 * | customer | decline      | awaiting_approval          | before approveBy                     | cancelled | released |
 * | customer | approve / decline | awaiting_approval (approveBy passed) or expired | any time | approval_expired |
 * | customer | approve / decline | any other status      | any time                             | approval_closed      |
 * | system   | expire       | awaiting_approval          | at or after approveBy                | expired   | released |
 * | system   | expire       | awaiting_approval          | before approveBy                     | invalid_request      |
 * | system   | expire       | any other status           | any time                             | invalid_request      |
 * | agent    | cancel       | confirmed                  | start − now >= cancelWindowHours     | cancelled | released |
 * | agent    | cancel       | confirmed                  | before start, inside the window      | cancelled | captured |
 * | agent    | cancel       | confirmed                  | after start                          | not_cancellable      |
 * | agent    | cancel       | awaiting_approval / awaiting_deposit | any time                   | cancelled | released |
 * | owner    | cancel       | awaiting_approval          | any time                             | cancelled | released |
 * | owner    | cancel       | awaiting_deposit/confirmed | before start                         | cancelled | released |
 * | owner    | cancel       | awaiting_deposit/confirmed | after start                          | invalid_request      |
 * | owner    | complete     | confirmed                  | after start                          | completed | released |
 * | owner    | mark_no_show | confirmed                  | after start                          | no_show   | captured |
 * | owner    | complete / mark_no_show | confirmed       | before start                         | invalid_request      |
 * | owner    | complete / mark_no_show | awaiting_approval / awaiting_deposit | any time       | invalid_request      |
 * | agent    | any          | cancelled/expired/completed/no_show | any time                    | not_cancellable      |
 * | owner    | any          | cancelled/expired/completed/no_show | any time                    | invalid_request      |
 * | any      | an action not in its list (agent: cancel; owner: cancel, complete, mark_no_show;  | invalid_request      |
 * |          | customer: approve, decline; system: expire) | any status | any time               |                      |
 *
 * A booking with depositCents 0 always gets depositEffect "none" instead of released/captured. No money
 * moves during a hold (released: the person keeps everything); approve's "none" becomes awaiting_deposit
 * in Ring 1c.
 * The last row is checked first: an actor asking for an action that isn't theirs gets invalid_request
 * whatever the status (e.g. an agent asking to complete or mark a no-show).
 *
 * Returns the decision, or a FrontDeskError (not thrown) for a transition the table doesn't allow:
 * `not_cancellable` (details.status, and details.start when the start has passed) for agents,
 * `invalid_request` (details.status, details.action) for owners and the system, `approval_expired` or
 * `approval_closed` (details.status) for the person. Every error has a next_action; when
 * policies.phone is set, the ones that end in "call the shop" include it.
 * Throws a plain Error if booking.start isn't an RFC 3339 instant, or if approve, decline or expire
 * meet an awaiting_approval booking without approveBy (bugs, not caller mistakes).
 */
export function decide(
  booking: DecideBooking,
  action: { type: LifecycleAction; actor: LifecycleActor },
  now: Date,
  policies: DecidePolicies,
): Decision | FrontDeskError;
export function decide(
  subject: BookProposal | DecideBooking,
  action: { type: LifecycleAction | "book"; actor: LifecycleActor },
  now: Date,
  policies?: DecidePolicies,
): BookDecision | Decision | FrontDeskError {
  if (action.type === "book") return decideBook(subject as BookProposal, now);
  const booking = subject as DecideBooking;
  const { type, actor } = action;
  if (!policies) throw new Error("decide() needs the shop's policies for a transition.");

  const start = parseRfc3339(booking.start);
  if (!start) throw new Error(`Booking ${booking.id} has a start that isn't RFC 3339: "${booking.start}"`);
  const msUntilStart = start.getTime() - now.getTime();
  const started = msUntilStart <= 0;

  if (!ACTOR_ACTIONS[actor].includes(type)) return notYourAction(booking, type, actor);

  if (type === "approve" || type === "decline") return decideAnswer(booking, type, now);
  if (type === "expire") return decideExpire(booking, now);

  if (isFinal(booking.status)) {
    return actor === "agent"
      ? notCancellable(booking, ALREADY[booking.status], policies.phone)
      : ownerOnFinal(booking, booking.status, type);
  }

  if (type === "cancel") {
    if (booking.status === "awaiting_approval") {
      // Agent or owner: a hold can be dropped any time, nothing has been approved or paid.
      return { nextStatus: "cancelled", depositEffect: depositEffect(booking, "released") };
    }
    if (actor === "agent") {
      if (booking.status === "awaiting_deposit") {
        return { nextStatus: "cancelled", depositEffect: depositEffect(booking, "released") };
      }
      if (started) {
        return notCancellable(booking, "This appointment has already started.", policies.phone, {
          start: booking.start,
        });
      }
      const outsideWindow = msUntilStart >= policies.cancelWindowHours * MS_PER_HOUR;
      return { nextStatus: "cancelled", depositEffect: depositEffect(booking, outsideWindow ? "released" : "captured") };
    }
    if (started) {
      return invalidAction(
        booking,
        type,
        "You can only cancel a booking before its start time.",
        booking.status === "confirmed" ? "Mark it completed or a no-show instead." : OWNER_LEAVE_AWAITING,
      );
    }
    return { nextStatus: "cancelled", depositEffect: depositEffect(booking, "released") };
  }

  // complete / mark_no_show, by the owner, from awaiting_approval, awaiting_deposit or confirmed.
  if (booking.status !== "confirmed") {
    const next =
      booking.status === "awaiting_approval"
        ? OWNER_NOT_APPROVED
        : started
          ? OWNER_LEAVE_AWAITING
          : "Cancel it instead if the appointment isn't going ahead.";
    return invalidAction(booking, type, `${BOOKING_IN[booking.status]} can't be ${ACTION_DONE[type]}.`, `${OWNER_ONLY_CONFIRMED} ${next}`);
  }
  if (!started) {
    return invalidAction(
      booking,
      type,
      `You can only mark a booking ${type === "complete" ? "completed" : "as a no-show"} after its start time.`,
      "Try again once the appointment has started, or cancel the booking if it isn't going ahead.",
    );
  }
  return type === "complete"
    ? { nextStatus: "completed", depositEffect: depositEffect(booking, "released") }
    : { nextStatus: "no_show", depositEffect: depositEffect(booking, "captured") };
}
