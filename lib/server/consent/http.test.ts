import { describe, expect, it } from "vitest";
import type { ApiError, ApprovalView, ApproveResponse, DeclineResponse } from "../../types/frontdesk";
import { book, type FrontDeskDeps } from "../frontdesk/service";
import { approvalToken, memoryDeps, PHONE_E164, recordingNotifier } from "../frontdesk/test-support";
import { approvalApprovePost, approvalDeclinePost, approvalGet } from "./http";

// The approval routes' HTTP handlers (what app/api/approvals/[token]/* call), on in-memory deps.

const SAT_1400 = "2026-11-14T14:00:00-05:00";
const BASE = "http://localhost:3000";

async function setup() {
  const notifier = recordingNotifier();
  const deps = memoryDeps({ notifier });
  const { booking } = await book(deps, "harts", { service_id: "haircut", start: SAT_1400, customer_name: "Maya" }, "Claude");
  return { deps, getDeps: () => deps, token: approvalToken(booking), booking, notifier };
}

/** A POST to an approval route. `body` undefined sends no body; a string is sent as is. */
function post(token: string, path: "approve" | "decline", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/api/approvals/${token}/${path}`, {
    method: "POST",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("approval routes: the flow over HTTP", () => {
  it("GET view → POST approve with no body → 200 confirmed, verified, no phone; the owner is alerted once", async () => {
    const { getDeps, token, booking, notifier } = await setup();
    const view = await approvalGet(getDeps, token);
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("no-store");
    const viewBody = (await view.json()) as ApprovalView;
    expect(viewBody.status).toBe("pending");
    expect(viewBody).not.toHaveProperty("codeSentTo");

    const res = await approvalApprovePost(getDeps, post(token, "approve"), token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { booking: approved } = (await res.json()) as ApproveResponse;
    expect(approved).toMatchObject({ id: booking.id, status: "confirmed", customer: { displayName: "Maya", verified: true } });
    expect(approved.customer).not.toHaveProperty("phoneLast4");
    expect(notifier.alerts).toHaveLength(1);
    expect(((await (await approvalGet(getDeps, token)).json()) as ApprovalView).status).toBe("approved");
  });

  it("POST approve with {} or a phone (separators ignored) → 200; phoneLast4 only with a phone", async () => {
    const empty = await setup();
    const res = await approvalApprovePost(empty.getDeps, post(empty.token, "approve", {}), empty.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApproveResponse).booking.customer).toEqual({ displayName: "Maya", verified: true });

    const withPhone = await setup();
    const res2 = await approvalApprovePost(withPhone.getDeps, post(withPhone.token, "approve", { phone: "+1 (401) 555-0123" }), withPhone.token);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as ApproveResponse).booking.customer).toEqual({ displayName: "Maya", verified: true, phoneLast4: "0123" });
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

  it("accepts POSTs whatever the Origin header says, or without one (there is no Origin check)", async () => {
    for (const origin of [undefined, "https://evil.example", "null", "http://localhost:3001"]) {
      const { getDeps, token } = await setup();
      const headers: Record<string, string> = origin === undefined ? {} : { origin };
      const res = await approvalApprovePost(getDeps, post(token, "approve", { phone: PHONE_E164 }, headers), token);
      expect(res.status, String(origin)).toBe(200);
    }
    const { getDeps, token } = await setup();
    expect((await approvalDeclinePost(getDeps, post(token, "decline", undefined, { origin: "https://evil.example" }), token)).status).toBe(200);
  });
});

describe("approval routes: errors and status codes", () => {
  it("unknown token → 404 booking_not_found, on GET and both POSTs", async () => {
    const { getDeps } = await setup();
    const token = "A".repeat(43);
    for (const res of [
      await approvalGet(getDeps, token),
      await approvalApprovePost(getDeps, post(token, "approve"), token),
      await approvalDeclinePost(getDeps, post(token, "decline"), token),
    ]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiError).error.code).toBe("booking_not_found");
    }
  });

  it("approve: a body that isn't JSON or isn't an object → 400 invalid_request (field body); a bad phone → 400 (field phone, not echoed)", async () => {
    const { getDeps, token } = await setup();
    const broken = await approvalApprovePost(getDeps, post(token, "approve", "{"), token);
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as ApiError).error).toMatchObject({ code: "invalid_request", details: { field: "body" } });

    const notObject = await approvalApprovePost(getDeps, post(token, "approve", "[1]"), token);
    expect(notObject.status).toBe(400);
    expect(((await notObject.json()) as ApiError).error).toMatchObject({ code: "invalid_request", details: { field: "body" } });

    const badPhone = await approvalApprovePost(getDeps, post(token, "approve", { phone: "6175559876" }), token);
    expect(badPhone.status).toBe(400);
    const body = (await badPhone.json()) as ApiError;
    expect(body.error).toMatchObject({ code: "invalid_request", details: { field: "phone" } });
    expect(JSON.stringify(body)).not.toContain("6175559876");

    // Nothing was approved by the failed attempts.
    expect(((await (await approvalGet(getDeps, token)).json()) as ApprovalView).status).toBe("pending");
  });

  it("decline ignores its body, even malformed", async () => {
    const { getDeps, token } = await setup();
    expect((await approvalDeclinePost(getDeps, post(token, "decline", "{not json"), token)).status).toBe(200);
  });

  it("approved, then approve or decline again → 409 approval_closed", async () => {
    const { getDeps, token } = await setup();
    expect((await approvalApprovePost(getDeps, post(token, "approve"), token)).status).toBe(200);
    for (const res of [
      await approvalApprovePost(getDeps, post(token, "approve"), token),
      await approvalDeclinePost(getDeps, post(token, "decline"), token),
    ]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as ApiError).error.code).toBe("approval_closed");
    }
  });

  it("a lapsed hold → 410 approval_expired", async () => {
    const { token, deps } = await setup();
    // The same store, with the clock 10 minutes on.
    const moved: FrontDeskDeps = { ...deps, clock: { now: () => new Date(deps.clock.now().getTime() + 10 * 60_000) } };
    for (const res of [
      await approvalApprovePost(() => moved, post(token, "approve"), token),
      await approvalDeclinePost(() => moved, post(token, "decline"), token),
    ]) {
      expect(res.status).toBe(410);
      expect(((await res.json()) as ApiError).error.code).toBe("approval_expired");
    }
  });

  it("a configuration error → 500 internal, without leaking it", async () => {
    const res = await approvalApprovePost(
      () => {
        throw new Error("DATABASE_URL is not set");
      },
      post("x".repeat(43), "approve"),
      "x".repeat(43),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });
});
