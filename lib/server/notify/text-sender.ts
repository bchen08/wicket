import type { TextingMode } from "../../types/texting";

// Texting: one interface, two senders (photon.ts, twilio.ts). Which one runs is decided in texting.ts.
// Callers take a TextSender | null (FrontDeskDeps.texter): null is "off".

export type TextProvider = Exclude<TextingMode, "off">;

/** Sends one text message. */
export interface TextSender {
  readonly provider: TextProvider;
  /**
   * Text `body` to `to` (E.164). Resolves once the provider accepted it; throws otherwise, with the
   * provider's own message when it gave one (e.g. "Twilio answered HTTP 400: The 'To' number … is not a
   * valid phone number.").
   */
  send(to: string, body: string): Promise<void>;
}

// ---- Shared by the senders ----

/** How long a provider gets to answer before the send counts as failed. */
export const SEND_TIMEOUT_MS = 8_000;

/** At most `max` characters of `text`, on one line. */
function snippet(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The error for a provider that didn't answer (network error, timeout). */
export function providerUnreachable(provider: string, err: unknown): Error {
  return new Error(`${provider} didn't answer: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * The error for a provider that answered with a non-2xx status: "<provider> answered HTTP <status>: <message>".
 * The message is the JSON body's `message` (Twilio) or `detail` / `title` (problem+json, Photon), after its
 * string `code` when that isn't a number (e.g. "SHARED_LINE_INBOUND_REQUIRED: …"); else the body's text.
 */
export async function providerRefused(provider: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; detail?: unknown; title?: unknown; code?: unknown };
    const text = [parsed.message, parsed.detail, parsed.title].find((v): v is string => typeof v === "string" && v.trim() !== "");
    const code = typeof parsed.code === "string" && parsed.code.trim() !== "" ? parsed.code.trim() : null;
    if (text || code) message = [code, text].filter(Boolean).join(": ");
  } catch {
    // Not JSON: keep the text.
  }
  return new Error(`${provider} answered HTTP ${res.status}${message.trim() ? `: ${snippet(message)}` : ""}`);
}
