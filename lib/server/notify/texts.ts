import { randomInt } from "node:crypto";
import { alertSubject } from "./email";
import type { OwnerAlert } from "./notifier";

// What Front Desk's text messages say. Short: one or two sentences and a link. Sent by a TextSender
// (text-sender.ts) where texting is on.

/** The approval link text to the person, sent by book when the agent gave their phone. */
export function approvalLinkText(input: {
  agentName: string;
  shopName: string;
  serviceName: string;
  /** The booking's start for people, e.g. "Sat 14 Nov, 2:30 pm EST" (Booking.display). */
  display: string;
  /** The approval link (Booking.approval.url). */
  url: string;
}): string {
  return `${input.agentName} asked ${input.shopName} to book ${input.serviceName} on ${input.display} for you. Approve or decline: ${input.url}`;
}

/**
 * The owner alert as a text: "New booking: Haircut, Sat 14 Nov 2:00 pm, Maya Lopez (booked by claude-ai).
 * All bookings: <console>", or "Cancelled: …, Maya Lopez (the customer declined). …".
 */
export function ownerAlertText(alert: OwnerAlert): string {
  const { booking } = alert;
  const why =
    alert.kind === "booking_confirmed"
      ? `booked by ${booking.agent.name}`
      : alert.cancelledBy === "customer"
        ? "the customer declined"
        : `${booking.agent.name} cancelled`;
  return `${alertSubject(alert)}, ${booking.customer.displayName} (${why}). All bookings: ${alert.consoleUrl}`;
}

/** A new code to text: six random digits, e.g. "042917". */
export function newTextedCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The sign-in code text to a person connecting an agent at /signin. */
export function signinCodeText(code: string, shopName: string): string {
  return `${code} is your code to sign in to ${shopName} on Front Desk. It works once, for 10 minutes.`;
}

/** The owner's sign-in code text. */
export function ownerCodeText(code: string, shopName: string): string {
  return `${code} is your Front Desk code for ${shopName}. It works once, for 10 minutes.`;
}
