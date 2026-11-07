import type { ApiError, ApprovalView, ApproveResponse, DeclineResponse, SendCodeResponse } from "../../types/frontdesk";
import { errorResponse, NO_STORE, readJson, respond } from "../frontdesk/http";
import type { FrontDeskDeps } from "../frontdesk/service";
import { approveBooking, declineBooking, getApprovalView, sendApprovalCode } from "./approvals";

// The HTTP side of /api/approvals/[token]/*: public routes where the token in the path is the
// credential. Route files stay thin (await connection(), read params, call one of these), and tests
// drive these directly with in-memory deps.
//
// CSRF: every POST must carry an Origin header equal to PUBLIC_BASE_URL's origin (the approval page's
// own origin), or it's refused with 403 invalid_request before anything is read or written. Browsers
// always send Origin on a cross-site POST, so another site can't approve or decline for the person.

/** Why a POST's Origin isn't acceptable, or null if it is. */
export function originRefusal(request: Request, publicBaseUrl: string): ApiError | null {
  const expected = new URL(publicBaseUrl).origin;
  if (request.headers.get("origin") === expected) return null;
  return {
    error: {
      code: "invalid_request",
      message: "This request must come from the approval page.",
      next_action: "Open the approval link in a browser and answer on that page.",
      details: { field: "origin" },
    },
  };
}

/** Resolve deps, check the Origin, then run `run` and answer JSON. */
async function approvalPost<T>(
  getDeps: () => FrontDeskDeps,
  request: Request,
  run: (deps: FrontDeskDeps) => Promise<T>,
): Promise<Response> {
  let deps: FrontDeskDeps;
  try {
    deps = getDeps();
  } catch (err) {
    return errorResponse(err); // a configuration error: 500 internal
  }
  const refusal = originRefusal(request, deps.consent.publicBaseUrl);
  if (refusal) return Response.json(refusal, { status: 403, headers: NO_STORE });
  return respond(() => run(deps));
}

/** GET /api/approvals/[token] → ApprovalView. No Origin check: it changes nothing but lazy expiry. */
export function approvalGet(getDeps: () => FrontDeskDeps, token: string): Promise<Response> {
  return respond<ApprovalView>(() => getApprovalView(getDeps(), token));
}

/** POST /api/approvals/[token]/code (SendCodeRequest) → SendCodeResponse. */
export function approvalCodePost(getDeps: () => FrontDeskDeps, request: Request, token: string): Promise<Response> {
  return approvalPost<SendCodeResponse>(getDeps, request, async (deps) =>
    sendApprovalCode(deps, token, await readJson(request)),
  );
}

/** POST /api/approvals/[token]/approve (ApproveRequest) → ApproveResponse. */
export function approvalApprovePost(getDeps: () => FrontDeskDeps, request: Request, token: string): Promise<Response> {
  return approvalPost<ApproveResponse>(getDeps, request, async (deps) =>
    approveBooking(deps, token, await readJson(request)),
  );
}

/** POST /api/approvals/[token]/decline → DeclineResponse. Ignores the body. */
export function approvalDeclinePost(getDeps: () => FrontDeskDeps, request: Request, token: string): Promise<Response> {
  return approvalPost<DeclineResponse>(getDeps, request, (deps) => declineBooking(deps, token));
}
