// Settings and limits for customer consent (Ring 1b). Env vars are read once, in
// createFrontDeskDeps (lib/server/frontdesk/deps.ts), and passed in as ConsentConfig.

export type ConsentConfig = {
  /**
   * Origin (plus optional path) the approval links point at and the approval POSTs must come from,
   * without a trailing slash, e.g. "https://frontdesk.example.com". PUBLIC_BASE_URL; locally
   * http://localhost:3000, on Vercel https://${VERCEL_URL} when unset.
   */
  publicBaseUrl: string;
  /** PHONE_HMAC_PEPPER: the key phone numbers are HMACed with before they're stored. */
  phonePepper: string;
  /**
   * true: SendCodeResponse includes the code (devCode), so the flow is demoable without a phone.
   * Only when FRONTDESK_DEV_CODES=1 and VERCEL_ENV isn't "production".
   */
  devCodes: boolean;
};

/** How long a code works after it's sent. */
export const CODE_TTL_MINUTES = 10;
/** Approve attempts allowed per code; after that a new code is needed. */
export const MAX_CODE_ATTEMPTS = 5;
/** Codes per phone number per hour, across all approval links. */
export const SENDS_PER_PHONE_PER_HOUR = 3;
/** Codes per approval link per hour. */
export const SENDS_PER_LINK_PER_HOUR = 10;
/** The send limits' sliding window. */
export const SEND_WINDOW_MS = 60 * 60 * 1000;

/** Shortest PHONE_HMAC_PEPPER accepted, after trimming (32 random bytes encode to 43+ characters). */
export const MIN_PEPPER_LENGTH = 32;

/** The approval page's path, under publicBaseUrl. The page itself is built separately (v0). */
export function approvalUrl(config: Pick<ConsentConfig, "publicBaseUrl">, token: string): string {
  return `${config.publicBaseUrl}/approve/${token}`;
}
