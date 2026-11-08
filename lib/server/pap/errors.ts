import type { PapErrorBody } from "../../types/agents";

// PAP 0.4's errors for a refused Session header (section 7): HTTP 400 with a JSON body.

export type PapErrorCode = PapErrorBody["error"];

/**
 * A Poppy-Session header Front Desk refuses. invalid_session: verification failed, and a new Session won't
 * fix it until the agent fixes the cause (the message says which). version_unsupported: Poppy-Version is
 * missing or not one Front Desk serves.
 */
export class PapError extends Error {
  readonly code: PapErrorCode;

  constructor(code: PapErrorCode, message: string) {
    super(message);
    this.name = "PapError";
    this.code = code;
  }
}

/** The error as PAP's response: 400, { error, error_description }, never cached. */
export function papErrorResponse(err: PapError): Response {
  const body: PapErrorBody = { error: err.code, error_description: err.message };
  return Response.json(body, { status: 400, headers: { "cache-control": "no-store" } });
}
