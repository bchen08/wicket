import type { Booking } from "../../types/frontdesk";

/** Tells a shop owner about something that happened to their calendar. */
export interface Notifier {
  /**
   * The person approved a booking: it is now confirmed (customer.approved true). Called once per
   * booking, never for a hold that is only awaiting approval. Implementations may fail; the approve
   * use case logs the failure and still returns the booking, because it is confirmed by then.
   */
  alertOwner(booking: Booking): Promise<void>;
}
