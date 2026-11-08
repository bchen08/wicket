import { providerRefused, providerUnreachable, SEND_TIMEOUT_MS, type TextSender } from "./text-sender";

// Twilio SMS: one text through Twilio's REST API (no SDK, no dependency).
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//   Basic auth AccountSid:AuthToken, form-encoded To, Body, and From (a Twilio number) or MessagingServiceSid.
// Errors come back as JSON { code, message, more_info, status }.

/** Twilio's API root. */
export const TWILIO_API = "https://api.twilio.com/2010-04-01";

export type TwilioOptions = {
  /** TWILIO_ACCOUNT_SID, e.g. "AC…". */
  accountSid: string;
  /** TWILIO_AUTH_TOKEN. */
  authToken: string;
  /**
   * TWILIO_FROM: the Twilio number to send from, E.164 (e.g. "+12125550100"), or a Messaging Service SID
   * ("MG…"), which Twilio then picks the number from.
   */
  from: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
};

/** The Messages endpoint for `accountSid`. */
export function twilioMessagesUrl(accountSid: string): string {
  return `${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

/** A TextSender that sends SMS through Twilio. */
export function createTwilioSender(options: TwilioOptions): TextSender {
  const doFetch = options.fetch ?? fetch;
  const from = options.from.trim();
  const auth = Buffer.from(`${options.accountSid.trim()}:${options.authToken.trim()}`).toString("base64");
  return {
    provider: "twilio",
    async send(to, body) {
      const form = new URLSearchParams({ To: to, Body: body });
      form.set(from.startsWith("MG") ? "MessagingServiceSid" : "From", from);
      let res: Response;
      try {
        res = await doFetch(twilioMessagesUrl(options.accountSid.trim()), {
          method: "POST",
          headers: {
            authorization: `Basic ${auth}`,
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "front-desk/1.0",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        throw providerUnreachable("Twilio", err);
      }
      if (res.ok) return;
      throw await providerRefused("Twilio", res);
    },
  };
}
