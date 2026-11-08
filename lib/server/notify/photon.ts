import { randomUUID } from "node:crypto";
import { providerRefused, providerUnreachable, SEND_TIMEOUT_MS, type TextSender } from "./text-sender";

// Photon iMessage: one text through Photon's HTTP API (https://api.photon.codes, the "Beta" API; no SDK,
// no dependency: Photon's SDKs hold a long-lived gRPC connection, which a serverless function can't keep).
// Sending to a phone number takes up to four calls, all `Authorization: Bearer <PHOTON_API_KEY>`:
//
//   1. POST /v1/projects/{project}/users   { platform: "imessage", handle: <PHOTON_LINE> }  → the sender's User id
//      (once per process; then remembered)
//   2. POST /v1/projects/{project}/users   { platform: "imessage", handle: <to> }           → the person's User id
//   3. POST /v1/projects/{project}/spaces  { platform: "imessage", participantIds: [sender, person] } → the chat
//   4. POST /v1/projects/{project}/messages { spaceId, senderId, content: { type: "text", format: "plain", text } }
//
// "Create or get": calls 1–3 return the existing User or Space when there is one. Photon requires an
// Idempotency-Key header on 3 and 4; each call sends a fresh random one (it is Photon's requirement, not a
// retry scheme of ours). Errors are application/problem+json { code, status, title, detail }.
//
// Limits (Photon's, docs/texting.md): only a dedicated line can text someone first; a shared line answers 403
// SHARED_LINE_INBOUND_REQUIRED unless the person texted it first. Photon has no SMS fallback switch: whether a
// number without iMessage still gets the text is up to Photon and Apple, not this code.

/** Photon's API root. */
export const PHOTON_API = "https://api.photon.codes";

export type PhotonOptions = {
  /** PHOTON_API_KEY: a project API key, "pho_sk_…". */
  apiKey: string;
  /** PHOTON_PROJECT_ID: "pho_prj_…". */
  projectId: string;
  /** PHOTON_LINE: the project's dedicated iMessage line, E.164, e.g. "+12125550100". Texts come from it. */
  line: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
};

/** A TextSender that sends iMessages through Photon. */
export function createPhotonSender(options: PhotonOptions): TextSender {
  const doFetch = options.fetch ?? fetch;
  const project = `${PHOTON_API}/v1/projects/${encodeURIComponent(options.projectId.trim())}`;
  const apiKey = options.apiKey.trim();
  const line = options.line.trim();
  let senderId: string | null = null;

  /** POST `body` to `path` under the project, with an Idempotency-Key when `idempotent`; the JSON answer. */
  async function post(path: string, body: unknown, idempotent: boolean): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${project}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "user-agent": "front-desk/1.0",
          ...(idempotent ? { "idempotency-key": randomUUID() } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerUnreachable("Photon", err);
    }
    if (!res.ok) throw await providerRefused("Photon", res);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return json ?? {};
  }

  /** The id in a create-or-get answer, or an error naming what was asked. */
  function idOf(json: Record<string, unknown>, what: string): string {
    if (typeof json.id !== "string" || json.id === "") throw new Error(`Photon answered without an id for ${what}.`);
    return json.id;
  }

  async function userId(handle: string, what: string): Promise<string> {
    return idOf(await post("/users", { platform: "imessage", handle }, false), what);
  }

  return {
    provider: "photon",
    async send(to, text) {
      senderId ??= await userId(line, "the line (PHOTON_LINE)");
      const personId = await userId(to, "the recipient");
      const spaceId = idOf(await post("/spaces", { platform: "imessage", participantIds: [senderId, personId] }, true), "the chat");
      await post("/messages", { spaceId, senderId, content: { type: "text", format: "plain", text } }, true);
    },
  };
}
