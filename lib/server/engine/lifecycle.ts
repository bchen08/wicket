import type { Booking, BookingStatus, DepositEffect, Policies } from "../../types/frontdesk";
import { FrontDeskError } from "../frontdesk/errors";
import { parseRfc3339 } from "../frontdesk/time";

// Pure booking lifecycle: given a booking, an action, the time and the shop's policies, decide the
// next status and what happens to the deposit. No I/O, no clock reads.
//
// TODO(ring-1c): move real money. Today every caller reports the depositEffect decided here with
// depositCollected: false.

/** What can be done to a booking. Agents may only cancel; owners may do all three. */
export type LifecycleAction = "cancel" | "complete" | "mark_no_show";

/** Who is acting. ("system", for deposit expiry, arrives in Ring 1c.) */
export type LifecycleActor = "agent" | "owner";

export type Decision = {
  nextStatus: BookingStatus;
  depositEffect: DepositEffect;
};

type DecideBooking = Pick<Booking, "id" | "status" | "start" | "depositCents">;

/** Statuses a booking never leaves. */
type FinalStatus = "cancelled" | "expired" | "completed" | "no_show";

const MS_PER_HOUR = 60 * 60 * 1000;

const FINAL_STATUSES: ReadonlySet<BookingStatus> = new Set<FinalStatus>(["cancelled", "expired", "completed", "no_show"]);

/** The status each action moves a booking to when it's allowed. */
const TARGET_STATUS: Record<LifecycleAction, BookingStatus> = {
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
};

const OWNER_FINAL_NEXT = "Don't retry: this booking is final and can't change any more. Reload it to see its current status and history.";
const OWNER_LEAVE_AWAITING =
  "Leave it as it is: a booking awaiting deposit expires on its own if the deposit isn't paid in time.";
const OWNER_ONLY_CONFIRMED = "Only a confirmed booking can be marked completed or a no-show.";

function isFinal(status: BookingStatus): status is FinalStatus {
  return FINAL_STATUSES.has(status);
}

/** The policy's deposit effect, or "none" when the booking has no deposit. */
function depositEffect(booking: DecideBooking, effect: "released" | "captured"): DepositEffect {
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

/** The booking's state doesn't allow this action. */
function invalidAction(booking: DecideBooking, action: LifecycleAction, message: string, nextAction: string): FrontDeskError {
  return new FrontDeskError("invalid_request", message, nextAction, {
    status: booking.status,
    action,
    booking_id: booking.id,
  });
}

/** An owner action on a final booking. */
function ownerOnFinal(booking: DecideBooking, status: FinalStatus, action: LifecycleAction): FrontDeskError {
  const message =
    TARGET_STATUS[action] === status ? ALREADY[status] : `${BOOKING_IN[status]} can't be ${ACTION_DONE[action]}.`;
  return invalidAction(booking, action, message, OWNER_FINAL_NEXT);
}

/**
 * The transition table (`start` is the booking's start; "before start" means now < start;
 * "after start" means now >= start):
 *
 * | actor | action       | from                       | when                                   | → status  | deposit  |
 * |-------|--------------|----------------------------|----------------------------------------|-----------|----------|
 * | agent | cancel       | confirmed                  | start − now >= cancelWindowHours       | cancelled | released |
 * | agent | cancel       | confirmed                  | before start, inside the window        | cancelled | captured |
 * | agent | cancel       | confirmed                  | after start                            | not_cancellable          |
 * | agent | cancel       | awaiting_deposit           | any time                               | cancelled | released |
 * | owner | cancel       | awaiting_deposit/confirmed | before start                           | cancelled | released |
 * | owner | cancel       | awaiting_deposit/confirmed | after start                            | invalid_request          |
 * | owner | complete     | confirmed                  | after start                            | completed | released |
 * | owner | mark_no_show | confirmed                  | after start                            | no_show   | captured |
 * | owner | complete / mark_no_show | confirmed       | before start                           | invalid_request          |
 * | owner | complete / mark_no_show | awaiting_deposit | any time                              | invalid_request          |
 * | agent | any          | cancelled/expired/completed/no_show | any time                      | not_cancellable          |
 * | owner | any          | cancelled/expired/completed/no_show | any time                      | invalid_request          |
 * | agent | complete / mark_no_show | any             | any time                               | invalid_request          |
 *
 * A booking with depositCents 0 always gets depositEffect "none" instead of released/captured.
 * The last row is checked first: an agent asking to complete or mark a no-show gets invalid_request
 * whatever the status, because the action itself isn't one agents may take.
 *
 * Returns the decision, or a FrontDeskError (not thrown) for a transition the table doesn't allow:
 * `not_cancellable` (details.status, and details.start when the start has passed) for agents,
 * `invalid_request` (details.status, details.action) for owners. Every error has a next_action; when
 * policies.phone is set, the ones that end in "call the shop" include it.
 * Throws a plain Error if booking.start isn't an RFC 3339 instant (a bug, not a caller mistake).
 */
export function decide(
  booking: DecideBooking,
  action: { type: LifecycleAction; actor: LifecycleActor },
  now: Date,
  policies: Pick<Policies, "cancelWindowHours" | "phone">,
): Decision | FrontDeskError {
  const start = parseRfc3339(booking.start);
  if (!start) throw new Error(`Booking ${booking.id} has a start that isn't RFC 3339: "${booking.start}"`);
  const msUntilStart = start.getTime() - now.getTime();
  const started = msUntilStart <= 0;
  const { type, actor } = action;

  if (actor === "agent" && type !== "cancel") {
    return invalidAction(
      booking,
      type,
      "Only the shop can mark a booking completed or a no-show.",
      "Don't retry: agents can only cancel a booking. The shop records completed appointments and no-shows itself.",
    );
  }

  if (isFinal(booking.status)) {
    return actor === "agent"
      ? notCancellable(booking, ALREADY[booking.status], policies.phone)
      : ownerOnFinal(booking, booking.status, type);
  }

  if (type === "cancel") {
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

  // complete / mark_no_show, by the owner, from awaiting_deposit or confirmed.
  if (booking.status !== "confirmed") {
    return invalidAction(
      booking,
      type,
      `${BOOKING_IN[booking.status]} can't be ${ACTION_DONE[type]}.`,
      `${OWNER_ONLY_CONFIRMED} ${started ? OWNER_LEAVE_AWAITING : "Cancel it instead if the appointment isn't going ahead."}`,
    );
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
