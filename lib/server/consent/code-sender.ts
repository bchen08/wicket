import { last4 } from "./crypto";

// How a one-time code reaches the person's phone.
// TODO(ring-1c): a Photon iMessage sender, with Resend as a fallback. Ring 1b only logs that a code
// was sent; locally, FRONTDESK_DEV_CODES=1 returns the code in the API response instead.

export type CodeMessage = {
  /** E.164, e.g. "+14015550123". */
  phoneE164: string;
  /** The 6-digit code. */
  code: string;
  /** For the message text, e.g. "Your Hart's Barbers code is 123456". */
  shopName: string;
  /** For logs and delivery receipts. */
  bookingId: string;
};

export interface CodeSender {
  /** Deliver the code. May throw; the caller reports it as an internal error. Never logs the code or the full number. */
  send(message: CodeMessage): Promise<void>;
}

/**
 * Ring 1b's sender: one JSON log line, { event: "otp.sent", phoneLast4, bookingId }, and nothing is
 * actually sent. The line never contains the code or the full phone number.
 */
export function createLogCodeSender(log: (line: string) => void = console.log): CodeSender {
  return {
    async send({ phoneE164, bookingId }) {
      log(JSON.stringify({ event: "otp.sent", phoneLast4: last4(phoneE164), bookingId }));
    },
  };
}
