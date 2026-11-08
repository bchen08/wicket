import type { ApprovalView, ApproveResponse, DeclineResponse } from "../../types/frontdesk";
import { FrontDeskError, toApiError } from "../frontdesk/errors";
import { isFormPost, NO_STORE, respond } from "../frontdesk/http";
import type { FrontDeskDeps } from "../frontdesk/service";
import { approveBooking, declineBooking, getApprovalView } from "./approvals";

// The HTTP side of /api/approvals/[token]/*: public routes where the token in the path is the
// credential. Route files stay thin (await connection(), read params, call one of these), and tests
// drive these directly with in-memory deps.
//
// approve and decline take JSON (answering JSON), or a plain HTML form post from the approval page
// (answering 303 → /approve/<token>, so the page shows the new status; a refusal adds ?error=<code>).

/** The request's JSON body, or undefined when it's empty. Malformed JSON is invalid_request (field "body"). */
async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FrontDeskError("invalid_request", "The request body isn't valid JSON.", "Send {} or { \"phone\": \"+14015550123\" }, or no body.", {
      field: "body",
    });
  }
}

/** The approval page's URL for `token`, on the request's origin, with ?error=<code> when given. */
function approvalPageUrl(request: Request, token: string, error: string | null): string {
  const url = new URL(`/approve/${encodeURIComponent(token)}`, request.url);
  if (error) url.searchParams.set("error", error);
  return url.toString();
}

/** Run a form post's answer, then 303 back to the approval page. A refusal's error code goes in ?error. */
async function formAnswer(request: Request, token: string, run: () => Promise<unknown>): Promise<Response> {
  let error: string | null = null;
  try {
    await run();
  } catch (err) {
    const body = toApiError(err);
    if (body.error.code === "internal") console.error("[frontdesk/approvals] internal error", err);
    error = body.error.code;
  }
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: approvalPageUrl(request, token, error) } });
}

/** GET /api/approvals/[token] → ApprovalView. */
export function approvalGet(getDeps: () => FrontDeskDeps, token: string): Promise<Response> {
  return respond<ApprovalView>(() => getApprovalView(getDeps(), token));
}

/**
 * POST /api/approvals/[token]/approve (ApproveRequest, optional) → ApproveResponse. A form post (optional
 * `phone` field) answers 303 → /approve/<token>.
 */
export function approvalApprovePost(getDeps: () => FrontDeskDeps, request: Request, token: string): Promise<Response> {
  if (isFormPost(request)) {
    return formAnswer(request, token, async () => {
      const phone = (await request.formData()).get("phone");
      return approveBooking(getDeps(), token, typeof phone === "string" ? { phone } : {});
    });
  }
  return respond<ApproveResponse>(async () => approveBooking(getDeps(), token, await readOptionalJson(request)));
}

/** POST /api/approvals/[token]/decline → DeclineResponse. Ignores the body. A form post answers 303 → /approve/<token>. */
export function approvalDeclinePost(getDeps: () => FrontDeskDeps, request: Request, token: string): Promise<Response> {
  if (isFormPost(request)) return formAnswer(request, token, () => declineBooking(getDeps(), token));
  return respond<DeclineResponse>(() => declineBooking(getDeps(), token));
}
