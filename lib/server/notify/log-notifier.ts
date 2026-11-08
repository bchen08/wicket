import { alertSubject } from "./email";
import type { OwnerAlert } from "./notifier";

/** The customer's first name only: everything before the first space. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? "";
}

/**
 * The log channel: one structured JSON line per alert (event "booking.confirmed" or "booking.cancelled"),
 * readable in Vercel's function logs. Used wherever alerts aren't emailed (no RESEND_API_KEY, e.g. previews,
 * or no ownerEmail). Logs no customer details beyond the first name.
 */
export function alertLogLine(alert: OwnerAlert): string {
  const { booking } = alert;
  return JSON.stringify({
    event: alert.kind === "booking_confirmed" ? "booking.confirmed" : "booking.cancelled",
    id: booking.id,
    shop: booking.shopSlug,
    service: booking.serviceId,
    start: booking.start,
    customer_first_name: firstName(booking.customer.displayName),
    ...(alert.cancelledBy ? { cancelled_by: alert.cancelledBy } : {}),
    subject: alertSubject(alert),
  });
}
