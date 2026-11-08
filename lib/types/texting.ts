// Texting: Front Desk sends text messages when a text sender is configured (Photon iMessage, or Twilio SMS).
// Re-exported from lib/types/frontdesk.ts. See docs/texting.md.
//
// - book (MCP `customer_phone`, web `phone`): the approval link goes to the person by text, and the result
//   says so (BookResult.texted, WebBookResponse.texted).
// - Owner alerts: also a text to Policies.ownerMobile (Alert.channel "text").
// - Owner sign-in: POST /api/owner/code texts a 6-digit code to ownerMobile; POST /api/owner/session takes
//   { code } as well as { token }.
// Without a text sender (texting "off"), none of this happens and everything works as it did before.

/**
 * How this deployment sends texts. `photon`: iMessage through Photon (PHOTON_* variables). `twilio`: SMS
 * through Twilio (TWILIO_* variables). `off`: no text sender configured; nothing is texted. Photon wins when
 * both are configured. `off` is not a problem.
 */
export type TextingMode = "photon" | "twilio" | "off";

/**
 * POST /api/owner/code body (JSON). Optional: an empty body (or none) is the same as {}. The same route
 * also takes a plain HTML form post (no fields), answering 303 → /console/unlock?code=sent, or
 * → /console/unlock?error=<reason> when it can't send (reason: texting_off, no_mobile, send_failed).
 */
export type OwnerCodeRequest = Record<string, never>;

/**
 * POST /api/owner/code → 200: a 6-digit code was texted to the shop's ownerMobile. It works once, for 10
 * minutes: send it to POST /api/owner/session as { code }. Errors: texting off, or no ownerMobile set →
 * 400 invalid_request; the text didn't go through → 500 internal (next_action says what to do).
 */
export type OwnerCodeResponse = {
  sent: true;
  /** Where it went, with all but the last 4 digits hidden, e.g. "•••• 0123". */
  sentTo: string;
  /** When the code stops working, RFC 3339 in UTC (e.g. "2026-11-08T10:10:00Z"): 10 minutes after sending. */
  expiresAt: string;
};
