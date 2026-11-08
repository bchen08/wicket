import type { PoppyDocument } from "../../types/agents";
import { PAP_VERSION } from "./session";

// PAP 0.4 discovery (section 3): the poppy.json Front Desk serves at /.well-known/poppy.json.
// Front Desk has no OAuth issuer, so it offers signed-out Sessions only, and its Company identifier is
// https://<host> (section 3.2): every preview and production domain is its own Company.

/** The Company identifier for the host that served `requestUrl`: `https://<host>`, host lowercased, no trailing slash. */
export function companyIdentifier(requestUrl: string): string {
  return `https://${new URL(requestUrl).host.toLowerCase()}`;
}

/** poppy.json for `origin` (e.g. "https://emergent.vercel.app"), speaking for the shop it serves. */
export function poppyDocument(origin: string, shopName: string): PoppyDocument {
  const url = new URL(origin);
  return {
    protocol_version: PAP_VERSION,
    organization: { name: shopName, domain: url.host.toLowerCase() },
    apis: [
      {
        type: "mcp",
        url: `${url.origin}/api/mcp`,
        description:
          `Book appointments at ${shopName}: services, booking rules, open times, book, check and cancel. ` +
          "Send the Poppy-Session header so the shop sees who booked; every booking still needs the person's approval.",
      },
    ],
  };
}
