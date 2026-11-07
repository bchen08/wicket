import type { Notifier } from "./notifier";

// TODO(ring-1c): alert the owner on a real channel (email or SMS) instead of a log line.

/** The customer's first name only: everything before the first space. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? "";
}

/**
 * Ring 0 notifier: one structured JSON log line per booking, readable in Vercel's logs.
 * Logs no customer details beyond the first name.
 */
export function createLogNotifier(log: (line: string) => void = console.log): Notifier {
  return {
    async alertOwner(booking) {
      log(
        JSON.stringify({
          event: "booking.created",
          id: booking.id,
          shop: booking.shopSlug,
          service: booking.serviceId,
          start: booking.start,
          customer_first_name: firstName(booking.customer.displayName),
        }),
      );
    },
  };
}
