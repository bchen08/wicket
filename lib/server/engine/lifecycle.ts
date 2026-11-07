import type { Booking, BookingStatus, DepositEffect, Policies } from "../../types/frontdesk";
import { FrontDeskError } from "../frontdesk/errors";

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
 *
 * Returns the decision, or a FrontDeskError (not thrown) for a transition the table doesn't allow:
 * `not_cancellable` (details.status, and details.start when the start has passed) for agents,
 * `invalid_request` (details.status, details.action) for owners. Every error has a next_action; when
 * policies.phone is set, the ones that end in "call the shop" include it.
 */
export function decide(
  booking: Pick<Booking, "id" | "status" | "start" | "depositCents">,
  action: { type: LifecycleAction; actor: LifecycleActor },
  now: Date,
  policies: Pick<Policies, "cancelWindowHours" | "phone">,
): Decision | FrontDeskError {
  void booking;
  void action;
  void now;
  void policies;
  // Implemented in Ring 1a wave 1.
  throw new Error("decide() is not implemented yet");
}
