import { randomUUID } from "node:crypto";
import { providerRefused, providerUnreachable, SEND_TIMEOUT_MS, type TextSender } from "./text-sender";

// Photon iMessage: one text through Photon's HTTP API (https://api.photon.codes, the "Beta" API; no SDK,
// no dependency: Photon's SDKs hold a long-lived gRPC connection, which a serverless function can't keep).
// Photon's shared iMessage pairs each person with their own line from the project's pool, so a text must come
// from the line that person was assigned. Sending to a phone number takes up to five calls (more if the list in
// call 1 runs over several pages), all `Authorization: Bearer <PHOTON_API_KEY>`:
//
//   1. GET  /v1/projects/{project}/platforms/imessage/assignments?pageSize=200 → the person's assignedPhoneNumber;
//      with none, the line is PHOTON_LINE. The list can't be filtered by handle, so this walks its pages.
//   2. POST /v1/projects/{project}/users   { platform: "imessage", handle: <the line> }     → the sender's User id
//      (once per line per process; then remembered)
//   3. POST /v1/projects/{project}/users   { platform: "imessage", handle: <to> }           → the person's User id
//   4. POST /v1/projects/{project}/spaces  { platform: "imessage", participantIds: [sender, person] } → the chat
//   5. POST /v1/projects/{project}/messages { spaceId, senderId, content: { type: "text", format: "plain", text } }
//
// "Create or get": calls 2–4 return the existing User or Space when there is one. Photon requires an
// Idempotency-Key header on 4 and 5; each call sends a fresh random one (it is Photon's requirement, not a
// retry scheme of ours). Errors are application/problem+json { code, status, title, detail }.
//
// Limits (Photon's, docs/texting.md): only a dedicated line can text someone first; a shared line sends only to
// a person assigned to it who texted it since (403 SHARED_LINE_NOT_ASSIGNED or SHARED_LINE_INBOUND_REQUIRED
// otherwise). Photon has no SMS fallback switch: whether a number without iMessage still gets the text is up to
// Photon and Apple, not this code.

/** Photon's API root. */
export const PHOTON_API = "https://api.photon.codes";

export type PhotonOptions = {
  /** PHOTON_API_KEY: a project API key, "pho_sk_…". */
  apiKey: string;
  /** PHOTON_PROJECT_ID: "pho_prj_…". */
  projectId: string;
  /** PHOTON_LINE: the iMessage line to send from when Photon has no assigned line for the person, E.164, e.g. "+12125550100". */
  line: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
};

/** One page of GET …/platforms/imessage/assignments (only the fields used here). */
type AssignmentPage = {
  assignments?: { handle: string; assignedPhoneNumber: string }[];
  nextPageToken?: string;
};

/** A TextSender that sends iMessages through Photon. */
export function createPhotonSender(options: PhotonOptions): TextSender {
  const doFetch = options.fetch ?? fetch;
  const project = `${PHOTON_API}/v1/projects/${encodeURIComponent(options.projectId.trim())}`;
  const apiKey = options.apiKey.trim();
  const fallbackLine = options.line.trim();
  /** Each line's User id, once known. */
  const senderIds = new Map<string, string>();

  /** Call `path` under the project with the key; the JSON answer. */
  async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${project}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${apiKey}`, "user-agent": "front-desk/1.0", ...init.headers },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerUnreachable("Photon", err);
    }
    if (!res.ok) throw await providerRefused("Photon", res);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return json ?? {};
  }

  /** POST `body` to `path` under the project, with an Idempotency-Key when `idempotent`; the JSON answer. */
  function post(path: string, body: unknown, idempotent: boolean): Promise<Record<string, unknown>> {
    return call(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(idempotent ? { "idempotency-key": randomUUID() } : {}) },
      body: JSON.stringify(body),
    });
  }

  /** The line Photon assigned to `to`, or null if it has none. A failed lookup throws: it isn't "none". */
  async function assignedLine(to: string): Promise<string | null> {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
      const page: AssignmentPage = await call(`/platforms/imessage/assignments?${query}`, { method: "GET" });
      const assignment = page.assignments?.find((a) => a.handle === to);
      if (assignment?.assignedPhoneNumber) return assignment.assignedPhoneNumber;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return null;
  }

  /** The id in a create-or-get answer, or an error naming what was asked. */
  function idOf(json: Record<string, unknown>, what: string): string {
    if (typeof json.id !== "string" || json.id === "") throw new Error(`Photon answered without an id for ${what}.`);
    return json.id;
  }

  async function userId(handle: string, what: string): Promise<string> {
    return idOf(await post("/users", { platform: "imessage", handle }, false), what);
  }

  async function senderIdOf(line: string): Promise<string> {
    const known = senderIds.get(line);
    if (known) return known;
    const id = await userId(line, `the line ${line}`);
    senderIds.set(line, id);
    return id;
  }

  return {
    provider: "photon",
    async send(to, text) {
      const senderId = await senderIdOf((await assignedLine(to)) ?? fallbackLine);
      const personId = await userId(to, "the recipient");
      const spaceId = idOf(await post("/spaces", { platform: "imessage", participantIds: [senderId, personId] }, true), "the chat");
      await post("/messages", { spaceId, senderId, content: { type: "text", format: "plain", text } }, true);
    },
  };
}
