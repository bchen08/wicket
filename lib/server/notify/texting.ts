import type { TextingMode } from "../../types/texting";
import { createPhotonSender } from "./photon";
import type { TextSender } from "./text-sender";
import { createTwilioSender } from "./twilio";

// Which text sender runs is decided by the environment, and only by which variables are set (docs/texting.md):
//
//   PHOTON_API_KEY, PHOTON_PROJECT_ID and PHOTON_LINE set   → Photon (iMessage; photon.ts)
//   else TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
//        TWILIO_FROM set                                     → Twilio (SMS; twilio.ts)
//   else                                                     → texting off: nothing is texted, and every
//                                                              feature works as it did before texting existed

type Env = Record<string, string | undefined>;

/** The variable, trimmed, or "" when unset. */
function setting(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

/** Which sender the environment configures (its variables are all set), or "off". Photon wins when both are. */
export function textingMode(env: Env): TextingMode {
  if (setting(env, "PHOTON_API_KEY") && setting(env, "PHOTON_PROJECT_ID") && setting(env, "PHOTON_LINE")) return "photon";
  if (setting(env, "TWILIO_ACCOUNT_SID") && setting(env, "TWILIO_AUTH_TOKEN") && setting(env, "TWILIO_FROM")) return "twilio";
  return "off";
}

/** The TextSender the environment configures (see textingMode), or null when texting is off. */
export function textSenderFrom(env: Env, fetchImpl?: typeof fetch): TextSender | null {
  switch (textingMode(env)) {
    case "photon":
      return createPhotonSender({
        apiKey: setting(env, "PHOTON_API_KEY"),
        projectId: setting(env, "PHOTON_PROJECT_ID"),
        line: setting(env, "PHOTON_LINE"),
        fetch: fetchImpl,
      });
    case "twilio":
      return createTwilioSender({
        accountSid: setting(env, "TWILIO_ACCOUNT_SID"),
        authToken: setting(env, "TWILIO_AUTH_TOKEN"),
        from: setting(env, "TWILIO_FROM"),
        fetch: fetchImpl,
      });
    case "off":
      return null;
  }
}

/** "•••• 0123": a phone number with all but its last 4 digits hidden, for showing where a text went. */
export function maskPhone(e164: string): string {
  return `•••• ${e164.slice(-4)}`;
}

