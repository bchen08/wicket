import { DateTime } from "luxon";
import type { DepositState } from "../../types/frontdesk";
import type { OwnerAlert } from "./notifier";

// The email channel: owner alerts as plain-text email through Resend's HTTP API (no SDK, no dependency).

/** Resend's send endpoint. */
export const RESEND_URL = "https://api.resend.com/emails";

/**
 * Who alerts come from. Resend's shared onboarding sender works without a verified domain, but then Resend
 * only delivers to the email address of the Resend account itself.
 * TODO(ring-3): send from the shop's own domain.
 */
export const ALERT_FROM = "Front Desk <onboarding@resend.dev>";

/** How long Resend gets to answer before the send counts as failed. The booking is committed either way. */
export const SEND_TIMEOUT_MS = 8_000;

/** "$35" for whole dollars, "$35.50" otherwise. */
function usd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** The start in the shop's zone, short, e.g. "Sat 14 Nov 2:00 pm". */
function shortStart(start: string, timezone: string): string {
  const local = DateTime.fromISO(start, { setZone: true }).setZone(timezone).setLocale("en-US");
  return `${local.toFormat("ccc d LLL h:mm")} ${local.hour < 12 ? "am" : "pm"}`;
}

/** "New booking: Haircut, Sat 14 Nov 2:00 pm", or "Cancelled: Haircut, Sat 14 Nov 2:00 pm". */
export function alertSubject(alert: OwnerAlert): string {
  const what = `${alert.booking.serviceName}, ${shortStart(alert.booking.start, alert.shop.timezone)}`;
  return alert.kind === "booking_confirmed" ? `New booking: ${what}` : `Cancelled: ${what}`;
}

/** Where the deposit stands, after "deposit $10 " (see DepositState in lib/types/deposits.ts). */
const DEPOSIT_WORDS: Record<DepositState, string> = {
  none: "not paid",
  awaiting_payment: "not paid yet",
  held: "held on the card",
  captured: "charged",
  released: "released",
  not_collected: "not collected",
};

/** The email's plain-text body: about 10 lines. Times are in the shop's zone (Booking.display). */
export function alertText(alert: OwnerAlert): string {
  const { booking, shop } = alert;
  const headline =
    alert.kind === "booking_confirmed"
      ? `New booking at ${shop.name}: the customer approved it.`
      : alert.cancelledBy === "customer"
        ? `The customer declined a booking at ${shop.name}. The time is free again.`
        : `The agent cancelled a booking at ${shop.name}. The time is free again.`;
  const deposit = booking.depositCents > 0 ? `deposit ${usd(booking.depositCents)} ${DEPOSIT_WORDS[booking.deposit.state]}` : "no deposit";
  return [
    headline,
    "",
    `Service: ${booking.serviceName}`,
    `When: ${booking.display}`,
    `Customer: ${booking.customer.displayName}`,
    ...(booking.customer.phone ? [`Phone: ${booking.customer.phone}`] : []),
    `Booked by: ${booking.agent.name}`,
    `Price: ${usd(alert.priceCents)} (${deposit})`,
    "",
    `All bookings: ${alert.consoleUrl}`,
  ].join("\n");
}

/** At most `max` characters of `text`, on one line. */
function snippet(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Email `alert` to `to` through Resend. Resolves once Resend accepted it (2xx); throws otherwise, with
 * Resend's own message when it gave one (e.g. "Resend answered HTTP 403: You can only send testing emails to
 * your own email address …").
 */
export async function sendAlertEmail(
  options: { apiKey: string; fetch: typeof fetch },
  to: string,
  alert: OwnerAlert,
): Promise<void> {
  let res: Response;
  try {
    res = await options.fetch(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        "user-agent": "front-desk/1.0",
      },
      body: JSON.stringify({ from: ALERT_FROM, to: [to], subject: alertSubject(alert), text: alertText(alert) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Resend didn't answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Not JSON: keep the text.
  }
  throw new Error(`Resend answered HTTP ${res.status}${message.trim() ? `: ${snippet(message)}` : ""}`);
}
