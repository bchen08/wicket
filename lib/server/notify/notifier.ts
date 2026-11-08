import type { AlertChannel, AlertKind, Booking, Shop } from "../../types/frontdesk";
import { sendAlertEmail } from "./email";
import { alertLogLine } from "./log-notifier";

/** Everything an owner alert says, gathered by alertOwner (service.ts) after the booking change committed. */
export type OwnerAlert = {
  kind: AlertKind;
  /** The booking as it is now: confirmed, or cancelled. */
  booking: Booking;
  shop: Shop;
  /** The service's price, in integer cents. */
  priceCents: number;
  /** The shop's Policies.ownerEmail: where an email goes, or null. */
  ownerEmail: string | null;
  /** booking_cancelled only: the agent cancelled it, or the person declined it. null for booking_confirmed. */
  cancelledBy: "agent" | "customer" | null;
  /** The owner's console on the deployment that served the request, e.g. "https://emergent.vercel.app/console". */
  consoleUrl: string;
};

/** Where one alert goes. */
export type AlertRoute = {
  channel: AlertChannel;
  /** The email address for channel "email"; null for "log". */
  recipient: string | null;
};

/** Tells a shop owner about a booking that was confirmed or cancelled. */
export interface Notifier {
  /** Where `alert` goes: decided before sending, so a failed send is still recorded with its channel. */
  route(alert: OwnerAlert): AlertRoute;
  /**
   * Send `alert` on `route`. Throws if it couldn't; alertOwner (service.ts) records that as a failed alert
   * and the booking is unaffected, because it is committed by then.
   */
  send(alert: OwnerAlert, route: AlertRoute): Promise<void>;
}

export type NotifierOptions = {
  /** RESEND_API_KEY. Unset or blank: every alert is logged. */
  resendApiKey?: string;
  /** For the Resend API. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Where log lines go. Defaults to console.log (Vercel's function logs). */
  log?: (line: string) => void;
};

/**
 * The owner notifier: an email through Resend when RESEND_API_KEY is set and the shop has an ownerEmail;
 * otherwise one JSON line in the log, so alerts work on every deployment (previews have no key).
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const apiKey = options.resendApiKey?.trim() ?? "";
  const log = options.log ?? ((line: string) => console.log(line));
  return {
    route(alert) {
      return apiKey && alert.ownerEmail ? { channel: "email", recipient: alert.ownerEmail } : { channel: "log", recipient: null };
    },
    async send(alert, route) {
      if (route.channel === "email") {
        if (!route.recipient) throw new Error("An email alert needs a recipient.");
        await sendAlertEmail({ apiKey, fetch: options.fetch ?? fetch }, route.recipient, alert);
      } else {
        log(alertLogLine(alert));
      }
    },
  };
}

/** A notifier that only ever logs: createNotifier without a Resend key. */
export function createLogNotifier(log?: (line: string) => void): Notifier {
  return createNotifier({ log });
}
