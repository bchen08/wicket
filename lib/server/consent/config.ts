// Settings for customer consent (Ring 1b). Env vars are read once, in createFrontDeskDeps
// (lib/server/frontdesk/deps.ts), and passed in as ConsentConfig.

export type ConsentConfig = {
  /**
   * Origin (plus optional path) the approval links point at, without a trailing slash, e.g.
   * "https://frontdesk.example.com". PUBLIC_BASE_URL; locally http://localhost:3000, on Vercel
   * https://${VERCEL_URL} when unset.
   */
  publicBaseUrl: string;
};

/** The approval page's path, under publicBaseUrl. The page itself is built separately (v0). */
export function approvalUrl(config: Pick<ConsentConfig, "publicBaseUrl">, token: string): string {
  return `${config.publicBaseUrl}/approve/${token}`;
}
