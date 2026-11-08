import type { ApiError } from "@/lib/types/frontdesk";
export type Feedback = {
  message: string;
  nextAction?: string;
  unauthorized?: boolean;
  saved?: boolean;
};
export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public nextAction?: string,
  ) {
    super(message);
  }
}
export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body: ApiError | null = await response.json().catch(() => null);
    throw new ApiFailure(
      body?.error?.message ?? `Request failed (${response.status}).`,
      response.status,
      body?.error?.next_action,
    );
  }
  return response.json() as Promise<T>;
}
export function errorFeedback(error: unknown): Feedback {
  return {
    message:
      error instanceof Error
        ? error.message
        : "Something went wrong. Please try again.",
    nextAction: error instanceof ApiFailure ? error.nextAction : undefined,
    unauthorized: error instanceof ApiFailure && error.status === 401,
  };
}
export async function writeSettings<T, B>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: B,
): Promise<T> {
  return readResponse<T>(
    await fetch(`/api/shops/harts/${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
