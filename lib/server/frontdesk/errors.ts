import type { ApiError, ApiErrorCode } from "../../types/frontdesk";

/** A failure we expect and can explain to the caller. Converted to an ApiError at the edge. */
export class FrontDeskError extends Error {
  readonly code: ApiErrorCode;
  readonly nextAction: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    nextAction: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FrontDeskError";
    this.code = code;
    this.nextAction = nextAction;
    this.details = details;
  }
}

/** Turn any thrown value into the ApiError envelope. Unknown errors become `internal` without leaking internals. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof FrontDeskError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        next_action: err.nextAction,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "internal",
      message: "Something went wrong on our side.",
      next_action: "Retry the same call once. If it fails again, tell the user Front Desk is unavailable right now.",
    },
  };
}
