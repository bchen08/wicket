import type { ApprovalView, ApproveResponse, DeclineResponse } from "../../types/frontdesk";
import { FrontDeskError } from "../frontdesk/errors";
import { respond } from "../frontdesk/http";
import type { FrontDeskDeps } from "../frontdesk/service";
import { approveBooking, declineBooking, getApprovalView } from "./approvals";

// The HTTP side of /api/approvals/[token]/*: public routes where the token in the path is the
// credential. Route files stay thin (await connection(), read params, call one of these), and tests
// drive these directly with in-memory deps.

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

/** GET /api/approvals/[token] → ApprovalView. */
export function approvalGet(getDeps: () => FrontDeskDeps, token: string): Promise<Response> {
  return respond<ApprovalView>(() => getApprovalView(getDeps(), token));
}

/** POST /api/approvals/[token]/approve (ApproveRequest, optional) → ApproveResponse. */
export function approvalApprovePost(getDeps: () => FrontDeskDeps, request: Request, token: string): Promise<Response> {
  return respond<ApproveResponse>(async () => approveBooking(getDeps(), token, await readOptionalJson(request)));
}

/** POST /api/approvals/[token]/decline → DeclineResponse. Ignores the body. */
export function approvalDeclinePost(getDeps: () => FrontDeskDeps, _request: Request, token: string): Promise<Response> {
  return respond<DeclineResponse>(() => declineBooking(getDeps(), token));
}
