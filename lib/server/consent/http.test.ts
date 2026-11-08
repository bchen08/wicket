import { describe, expect, it } from "vitest";
import type { ApiError, ApprovalView, ApproveResponse, DeclineResponse, SendCodeResponse } from "../../types/frontdesk";
import { book, type FrontDeskDeps } from "../frontdesk/service";
import { approvalToken, lastSentCode, memoryDeps, PHONE_E164, TEST_ORIGIN } from "../frontdesk/test-support";
import { approvalApprovePost, approvalCodePost, approvalDeclinePost, approvalGet } from "./http";

// The approval routes' HTTP handlers (what app/api/approvals/[token]/* call), on in-memory deps.

const SAT_1400 = "2026-11-14T14:00:00-05:00";

async function setup(consent: Partial<FrontDeskDeps["consent"]> = {}) {
  const deps = memoryDeps({ consent });
  const { booking } = await book(
    deps,
    "harts",
    { service_id: "haircut", start: SAT_1400, customer_name: "Maya", idempotency_key: crypto.randomUUID() },
    "Claude",
  );
  return { deps, getDeps: () => deps, token: approvalToken(booking), booking };
}

function post(token: string, path: "code" | "approve" | "decline", body?: unknown, origin: string | null = TEST_ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${TEST_ORIGIN}/api/approvals/${token}/${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("approval routes: Origin check (CSRF)", () => {
  it.each([
    ["no Origin header", null],
    ["another site", "https://evil.example"],
    ["another port", "http://localhost:3001"],
    ["https instead of http", "https://localhost:3000"],
    ["the string null", "null"],
  ])("refuses a POST with %s: 403 invalid_request, and changes nothing", async (_label, origin) => {
    const { getDeps, token, deps } = await setup();
    for (const [path, body] of [
      ["code", { phone: PHONE_E164 }],
      ["approve", { code: "123456" }],
      ["decline", undefined],
    ] as const) {
      const res = await (path === "code" ? approvalCodePost : path === "approve" ? approvalApprovePost : approvalDeclinePost)(
        getDeps,
        post(token, path, body, origin),
        token,
      );
      expect(res.status, path).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const json = (await res.json()) as ApiError;
      expect(json.error).toMatchObject({ code: "invalid_request", details: { field: "origin" } });
      expect(json.error.next_action).toMatch(/approval link/);
    }
    expect(((await (await approvalGet(getDeps, token)).json()) as ApprovalView).status).toBe("pending");
    expect((deps.codeSender as unknown as { sent: unknown[] }).sent).toHaveLength(0);
  });

  it("accepts PUBLIC_BASE_URL's origin, even when the base URL has a path", async () => {
    const { getDeps, token } = await setup({ publicBaseUrl: "https://frontdesk.example.com/app" });
    const res = await approvalCodePost(getDeps, post(token, "code", { phone: PHONE_E164 }, "https://frontdesk.example.com"), token);
    expect(res.status).toBe(200);
  });

  it("GET needs no Origin", async () => {
    const { getDeps, token } = await setup();
    const res = await approvalGet(getDeps, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("approval routes: the flow over HTTP", () => {
  it("GET view → POST code (devCode with dev codes on) → POST approve → 200 confirmed", async () => {
    const { getDeps, token, booking } = await setup({ devCodes: true });
    expect(((await (await approvalGet(getDeps, token)).json()) as ApprovalView).status).toBe("pending");

    const sent = await approvalCodePost(getDeps, post(token, "code", { phone: PHONE_E164 }), token);
    expect(sent.status).toBe(200);
    const sentBody = (await sent.json()) as SendCodeResponse;
    expect(sentBody).toEqual({ sentTo: "0123", expiresAt: "2026-11-09T12:10:00-05:00", devCode: expect.stringMatching(/^\d{6}$/) });

    const approved = await approvalApprovePost(getDeps, post(token, "approve", { code: sentBody.devCode }), token);
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as ApproveResponse;
    expect(body.booking).toMatchObject({ id: booking.id, status: "confirmed", customer: { verified: true, phoneLast4: "0123" } });
  });

  it("no devCode without dev codes", async () => {
    const { getDeps, token } = await setup();
    const body = (await (await approvalCodePost(getDeps, post(token, "code", { phone: PHONE_E164 }), token)).json()) as SendCodeResponse;
    expect(body).not.toHaveProperty("devCode");
  });

  it("POST decline → 200 cancelled; again → 409 approval_closed", async () => {
    const { getDeps, token } = await setup();
    const res = await approvalDeclinePost(getDeps, post(token, "decline"), token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as DeclineResponse).booking.status).toBe("cancelled");
    const again = await approvalDeclinePost(getDeps, post(token, "decline"), token);
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiError).error.code).toBe("approval_closed");
  });
});

describe("approval routes: errors and status codes", () => {
  it("unknown token → 404 booking_not_found", async () => {
    const { getDeps } = await setup();
    const res = await approvalGet(getDeps, "A".repeat(43));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("booking_not_found");
  });

  it("an empty or non-JSON body → 400 invalid_request", async () => {
    const { getDeps, token } = await setup();
    const empty = await approvalCodePost(getDeps, post(token, "code"), token);
    expect(empty.status).toBe(400);
    const broken = new Request(`${TEST_ORIGIN}/x`, { method: "POST", headers: { origin: TEST_ORIGIN }, body: "{" });
    expect((await approvalApprovePost(getDeps, broken, token)).status).toBe(400);
  });

  it("a wrong code → 422 code_invalid; the 5th → 429 too_many_attempts", async () => {
    const { getDeps, token, deps } = await setup();
    await approvalCodePost(getDeps, post(token, "code", { phone: PHONE_E164 }), token);
    const wrong = lastSentCode(deps) === "000000" ? "111111" : "000000";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await approvalApprovePost(getDeps, post(token, "approve", { code: wrong }), token)).status);
    expect(statuses).toEqual([422, 422, 422, 422, 429]);
  });

  it("rate_limited → 429 with a Retry-After header matching details.retryAfter", async () => {
    const { getDeps, token } = await setup();
    for (let i = 0; i < 3; i++) await approvalCodePost(getDeps, post(token, "code", { phone: PHONE_E164 }), token);
    const res = await approvalCodePost(getDeps, post(token, "code", { phone: PHONE_E164 }), token);
    expect(res.status).toBe(429);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBe(String(body.error.details?.retryAfter));
    expect(body.error.details?.retryAfter).toBe(3600);
  });

  it("a lapsed hold → 410 approval_expired", async () => {
    const { token, deps } = await setup();
    // The same store, with the clock 10 minutes on.
    const moved: FrontDeskDeps = { ...deps, clock: { now: () => new Date(deps.clock.now().getTime() + 10 * 60_000) } };
    const res = await approvalCodePost(() => moved, post(token, "code", { phone: PHONE_E164 }), token);
    expect(res.status).toBe(410);
    expect(((await res.json()) as ApiError).error.code).toBe("approval_expired");
  });

  it("a configuration error → 500 internal, before the Origin is checked", async () => {
    const res = await approvalCodePost(
      () => {
        throw new Error("DATABASE_URL is not set");
      },
      post("x".repeat(43), "code", { phone: PHONE_E164 }, null),
      "x".repeat(43),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });
});
