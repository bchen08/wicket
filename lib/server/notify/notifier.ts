import type { Booking } from "../../types/frontdesk";

/** Tells a shop owner about something that happened to their calendar. */
export interface Notifier {
  /**
   * A new booking was made. Implementations may fail; book() logs the failure and still
   * returns the booking, because the slot is already taken by then.
   */
  alertOwner(booking: Booking): Promise<void>;
}
