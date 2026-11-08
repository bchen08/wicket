import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApiError,
  BookResult,
  OwnerCodeResponse,
  OwnerSessionRequest,
  OwnerSessionResponse,
  PoliciesResponse,
  WebBookResponse,
} from "../../types/frontdesk";
import type { Clock } from "../clock";
import { approveBooking, declineBooking } from "../consent/approvals";
import { createPhotonSender } from "../notify/photon";
import { approvalLinkText, ownerAlertText } from "../notify/texts";
import { createFrontDeskDeps } from "./deps";
import { policiesGet, policiesPut, type OwnerOptions } from "./http";
import { createFrontDeskMcpHandler } from "./mcp";
import { ALERTS_LIMIT } from "./owner";
import { OWNER_SESSION_COOKIE } from "./owner-auth";
import { ownerCodePost, sendOwnerCode } from "./owner-code";
import { ownerSessionPost } from "./owner-session";
import { book, cancelBooking, getBooking, getPolicies, type FrontDeskDeps } from "./service";
import { approvalToken, failingTexter, memoryDeps, NOW, PHONE_E164, recordingTexter } from "./test-support";
import { bookPost } from "./web-http";

// Texting end to end on the in-memory store, with a stubbed text sender (recordingTexter) standing in for
// Photon or Twilio: the approval link texted by book (MCP and web) and flagged in the result, owner alerts
// texted to ownerMobile, the owner's sign-in code (sent, accepted once, refused after 10 minutes), and that
// with texting off nothing changes. "Now" is Mon 9 Nov 2026, noon in New York; bookings are for Sat 14 Nov.

const MIN = 60_000;
const SAT_1400 = "2026-11-14T14:00:00-05:00";
const SAT_1500 = "2026-11-14T15:00:00-05:00";
const OWNER_MOBILE = "+12125550199";
const TOKEN = "owner-token-for-tests-0123456789";
const OWNER: OwnerOptions = { getToken: () => TOKEN };
const ORIGIN = "http://localhost:3000";

afterEach(() => {
  vi.restoreAllMocks();
});

function movableClock(start: Date): Clock & { advance(ms: number): void } {
  let at = start.getTime();
  return { now: () => new Date(at), advance: (ms) => void (at += ms) };
}

const hold = (deps: FrontDeskDeps, extra: { customer_phone?: string } = {}, start = SAT_1400) =>
  book(deps, "harts", { service_id: "beard-trim", start, customer_name: "Maya Lopez", ...extra }, "claude-ai");

/** The recorded alerts as [kind, channel, recipient, status], oldest first. */
const recorded = async (deps: FrontDeskDeps) =>
  (await deps.store.listAlerts("harts", ALERTS_LIMIT)).reverse().map((a) => [a.kind, a.channel, a.recipient, a.status]);

/** The real Photon sender against a fake API that, like a shared pool, only lets a person's own assigned line text them. */
function photonTexter(assignments: { handle: string; assignedPhoneNumber: string }[]) {
  const sentFrom: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") return Response.json({ assignments });
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/users")) return Response.json({ id: body.handle });
    if (String(url).endsWith("/spaces")) return Response.json({ id: body.participantIds.join(" to ") });
    const [line, person] = String(body.spaceId).split(" to ");
    if (!assignments.some((a) => a.handle === person && a.assignedPhoneNumber === line)) {
      return Response.json({ code: "SHARED_LINE_NOT_ASSIGNED", status: 403, title: "Shared Line Not Assigned" }, { status: 403 });
    }
    sentFrom.push(line);
    return Response.json({ id: "pho_msg_1" }, { status: 202 });
  }) as typeof globalThis.fetch;
  return { texter: createPhotonSender({ apiKey: "pho_sk_test", projectId: "pho_prj_test", line: "+12125550100", fetch }), sentFrom };
}

// ---- The approval link by text ----

describe("book with the person's phone: the approval link by text", () => {
  it("texts the link to the phone, says so (texted: true), and stores the phone on the booking", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter });
    const outcome = await hold(deps, { customer_phone: "+1 (401) 555-0123" });
    const { booking } = outcome;
    expect(outcome.texted).toBe(true);
    expect(booking.status).toBe("awaiting_approval");
    expect(booking.customer.phone).toBe(PHONE_E164);
    expect(texter.sent).toEqual([
      {
        to: PHONE_E164,
        body: `claude-ai asked Hart's Barbers to book Beard trim on Sat 14 Nov, 2:00 pm EST for you. Approve or decline: ${booking.approval!.url}`,
      },
    ]);
    expect(texter.sent[0].body).toBe(
      approvalLinkText({ agentName: "claude-ai", shopName: "Hart's Barbers", serviceName: "Beard trim", display: booking.display, url: booking.approval!.url }),
    );
    expect(booking.approval!.url.startsWith(`${ORIGIN}/approve/`)).toBe(true);
    // Stored: get_booking shows the phone too.
    expect((await getBooking(deps, "harts", { booking_id: booking.id })).booking.customer.phone).toBe(PHONE_E164);
  });

  it("the person's phone from approving replaces the agent's", async () => {
    const deps = memoryDeps({ texter: recordingTexter() });
    const { booking } = await hold(deps, { customer_phone: PHONE_E164 });
    const approved = await approveBooking(deps, approvalToken(booking), { phone: "+14015550199" });
    expect(approved.booking.customer.phone).toBe("+14015550199");
    const kept = await approveBooking(deps, approvalToken((await hold(deps, { customer_phone: PHONE_E164 }, SAT_1500)).booking), {});
    expect(kept.booking.customer.phone).toBe(PHONE_E164);
  });

  it("MCP book: customer_phone in, texted: true in structuredContent, and the text tells the agent not to send it again", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter });
    const handler = createFrontDeskMcpHandler(() => deps);
    const res = await handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "book", arguments: { service_id: "beard-trim", start: SAT_1400, customer_name: "Maya", customer_phone: PHONE_E164 } },
        }),
      }),
    );
    const text = await res.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
    const result = JSON.parse(json).result as { structuredContent: BookResult; content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.texted).toBe(true);
    expect(result.structuredContent.booking.customer.phone).toBe(PHONE_E164);
    expect(result.content[0].text).toContain(`Front Desk texted Maya the approval link at ${PHONE_E164}, so don't send it again`);
    expect(texter.sent).toHaveLength(1);
  });

  it("web book: phone in, texted: true in the 201 answer, and next_action says not to send it again", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter });
    const res = await bookPost(
      () => deps,
      new Request(`${ORIGIN}/api/shops/harts/book`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "beard-trim", start: SAT_1400, name: "Maya", bookedBy: "maya-assistant", phone: "+1 401 555 0123" }),
      }),
      "harts",
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as WebBookResponse;
    expect(body.texted).toBe(true);
    expect(body.booking.customer.phone).toBe(PHONE_E164);
    expect(body.next_action).toContain(`Front Desk texted Maya the link to approve or decline at ${PHONE_E164}, so don't send it again`);
    expect(texter.sent[0].body.startsWith("maya-assistant asked Hart's Barbers to book Beard trim")).toBe(true);
  });

  it("web form post: a phone field is texted too", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter });
    const res = await bookPost(
      () => deps,
      new Request(`${ORIGIN}/api/shops/harts/book`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", referer: `${ORIGIN}/harts` },
        body: new URLSearchParams({ service: "beard-trim", start: SAT_1400, name: "Maya", phone: PHONE_E164 }).toString(),
      }),
      "harts",
    );
    expect(res.status).toBe(303);
    expect(texter.sent.map((t) => t.to)).toEqual([PHONE_E164]);
  });

  it("a text that doesn't go through: texted false, the hold stands, and the agent is told to send the link", async () => {
    const texter = failingTexter("Twilio answered HTTP 400: The 'To' number is not a valid phone number.");
    const deps = memoryDeps({ texter });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await hold(deps, { customer_phone: PHONE_E164 });
    expect(outcome.texted).toBe(false);
    expect(outcome.booking.status).toBe("awaiting_approval");
    expect(outcome.booking.customer.phone).toBe(PHONE_E164);
    expect(texter.tried).toHaveLength(1);
    // Logged without the number.
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("booking.approval_text_failed");
    expect(logged).not.toContain(PHONE_E164);
  });

  it("through Photon, a person with their own assigned line gets the link from that line (texted: true)", async () => {
    const { texter, sentFrom } = photonTexter([
      { handle: "+14015550999", assignedPhoneNumber: "+12125550188" },
      { handle: PHONE_E164, assignedPhoneNumber: "+12125550177" },
    ]);
    const outcome = await hold(memoryDeps({ texter }), { customer_phone: PHONE_E164 });
    expect(outcome.texted).toBe(true);
    expect(sentFrom).toEqual(["+12125550177"]);
  });

  it("through Photon, a number that isn't in the project fails cleanly: texted false, and the hold stands", async () => {
    const { texter, sentFrom } = photonTexter([{ handle: "+14015550999", assignedPhoneNumber: "+12125550188" }]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await hold(memoryDeps({ texter }), { customer_phone: PHONE_E164 });
    expect(outcome.texted).toBe(false);
    expect(outcome.booking.status).toBe("awaiting_approval");
    expect(sentFrom).toEqual([]);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("SHARED_LINE_NOT_ASSIGNED");
    expect(logged).not.toContain(PHONE_E164);
  });

  it("a phone that isn't E.164 is invalid_request on customer_phone (MCP) and phone (web), and nothing is held", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter });
    await expect(hold(deps, { customer_phone: "555-0123" })).rejects.toMatchObject({ code: "invalid_request", details: { field: "customer_phone" } });
    await expect(hold(deps, { customer_phone: 4015550123 as unknown as string })).rejects.toMatchObject({ details: { field: "customer_phone" } });
    const res = await bookPost(
      () => deps,
      new Request(`${ORIGIN}/api/shops/harts/book`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "beard-trim", start: SAT_1400, name: "Maya", phone: "call me" }),
      }),
      "harts",
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as ApiError;
    expect(error.details?.field).toBe("phone");
    expect(`${error.message} ${error.next_action}`).not.toContain("customer_phone");
    expect(texter.sent).toEqual([]);
    expect((await hold(deps)).booking.status).toBe("awaiting_approval"); // the time was never held
  });

  it("texting off: the phone is stored, nothing is texted, texted: false, and the agent sends the link", async () => {
    const deps = memoryDeps(); // texter null
    const outcome = await hold(deps, { customer_phone: PHONE_E164 });
    expect(outcome.texted).toBe(false);
    expect(outcome.booking.customer.phone).toBe(PHONE_E164);
  });

  it("no phone: nothing is texted, even with texting on", async () => {
    const texter = recordingTexter();
    const outcome = await hold(memoryDeps({ texter }));
    expect(outcome.texted).toBe(false);
    expect(outcome.booking.customer.phone).toBeUndefined();
    expect(texter.sent).toEqual([]);
  });
});

// ---- Owner alerts by text ----

describe("owner alerts by text to ownerMobile", () => {
  it("every new booking and cancellation is texted, and recorded as a text alert next to the log line", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter, policies: { ownerMobile: OWNER_MOBILE } });
    // New booking: the person approves.
    const confirmed = (await approveBooking(deps, approvalToken((await hold(deps)).booking), {})).booking;
    // Cancelled by the agent.
    await cancelBooking(deps, "harts", { booking_id: confirmed.id });
    // Declined by the person.
    const declined = (await hold(deps, {}, SAT_1500)).booking;
    await declineBooking(deps, approvalToken(declined));

    expect(await recorded(deps)).toEqual([
      ["booking_confirmed", "log", null, "logged"],
      ["booking_confirmed", "text", OWNER_MOBILE, "sent"],
      ["booking_cancelled", "log", null, "logged"],
      ["booking_cancelled", "text", OWNER_MOBILE, "sent"],
      ["booking_cancelled", "log", null, "logged"],
      ["booking_cancelled", "text", OWNER_MOBILE, "sent"],
    ]);
    expect(texter.sent.map((t) => t.to)).toEqual([OWNER_MOBILE, OWNER_MOBILE, OWNER_MOBILE]);
    expect(texter.sent[0].body).toBe(
      "New booking: Beard trim, Sat 14 Nov 2:00 pm, Maya Lopez (booked by claude-ai). All bookings: http://localhost:3000/console",
    );
    expect(texter.sent[1].body).toContain("Cancelled: Beard trim, Sat 14 Nov 2:00 pm, Maya Lopez (claude-ai cancelled)");
    expect(texter.sent[2].body).toContain("Cancelled: Beard trim, Sat 14 Nov 3:00 pm, Maya Lopez (the customer declined)");
  });

  it("the email (or log line) goes out as before; the text is extra", async () => {
    const texter = recordingTexter();
    const notified: string[] = [];
    const deps = memoryDeps({
      texter,
      policies: { ownerMobile: OWNER_MOBILE, ownerEmail: "dana@example.com" },
      notifier: { route: () => ({ channel: "email", recipient: "dana@example.com" }), send: async (a) => void notified.push(a.kind) },
    });
    await approveBooking(deps, approvalToken((await hold(deps)).booking), {});
    expect(notified).toEqual(["booking_confirmed"]);
    expect(await recorded(deps)).toEqual([
      ["booking_confirmed", "email", "dana@example.com", "sent"],
      ["booking_confirmed", "text", OWNER_MOBILE, "sent"],
    ]);
    expect(texter.sent[0].body).toBe(ownerAlertText({
      kind: "booking_confirmed",
      booking: (await getBooking(deps, "harts", { booking_id: (await deps.store.listAlerts("harts", 1))[0].bookingId })).booking,
      shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
      priceCents: 1500,
      ownerEmail: "dana@example.com",
      cancelledBy: null,
      consoleUrl: "http://localhost:3000/console",
    }));
  });

  it("a failed text is recorded as failed, with the error; the booking is untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = memoryDeps({ texter: failingTexter("Twilio answered HTTP 401: Authenticate"), policies: { ownerMobile: OWNER_MOBILE } });
    const confirmed = (await approveBooking(deps, approvalToken((await hold(deps)).booking), {})).booking;
    expect(confirmed.status).toBe("confirmed");
    const [text] = await deps.store.listAlerts("harts", 1);
    expect(text).toMatchObject({ channel: "text", recipient: OWNER_MOBILE, status: "failed", error: "Twilio answered HTTP 401: Authenticate" });
  });

  it("no text without an ownerMobile, or with texting off", async () => {
    const texter = recordingTexter();
    const noMobile = memoryDeps({ texter });
    await approveBooking(noMobile, approvalToken((await hold(noMobile)).booking), {});
    expect(await recorded(noMobile)).toEqual([["booking_confirmed", "log", null, "logged"]]);
    expect(texter.sent).toEqual([]);

    const off = memoryDeps({ policies: { ownerMobile: OWNER_MOBILE } });
    await approveBooking(off, approvalToken((await hold(off)).booking), {});
    expect(await recorded(off)).toEqual([["booking_confirmed", "log", null, "logged"]]);
  });
});

// ---- ownerMobile in the policies ----

describe("Policies.ownerMobile", () => {
  const put = (body: unknown) =>
    new Request(`${ORIGIN}/api/shops/harts/policies`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("is set through the owner's PUT as E.164, cleared with null, and the owner's GET shows it", async () => {
    const deps = memoryDeps();
    const saved = (await (await policiesPut(() => deps, put({ ownerMobile: "+1 (212) 555-0199" }), "harts", OWNER)).json()) as PoliciesResponse;
    expect(saved.policies.ownerMobile).toBe(OWNER_MOBILE);
    const read = (await (await policiesGet(() => deps, new Request(`${ORIGIN}/api/shops/harts/policies`, { headers: { authorization: `Bearer ${TOKEN}` } }), "harts", OWNER)).json()) as PoliciesResponse;
    expect(read.policies.ownerMobile).toBe(OWNER_MOBILE);
    const cleared = (await (await policiesPut(() => deps, put({ ownerMobile: null }), "harts", OWNER)).json()) as PoliciesResponse;
    expect(cleared.policies.ownerMobile).toBeNull();
  });

  it("a number that isn't E.164 is a 400 naming ownerMobile", async () => {
    for (const ownerMobile of ["555-0199", "", 2125550199, "+0123456789"]) {
      const res = await policiesPut(() => memoryDeps(), put({ ownerMobile }), "harts", OWNER);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.details?.field).toBe("ownerMobile");
    }
  });

  it("agents never see it (get_policies)", async () => {
    const deps = memoryDeps({ policies: { ownerMobile: OWNER_MOBILE } });
    expect(JSON.stringify(await getPolicies(deps, "harts"))).not.toContain(OWNER_MOBILE);
  });
});

// ---- Owner sign-in by texted code ----

describe("owner sign-in by texted code", () => {
  const codeIn = (texter: ReturnType<typeof recordingTexter>) => /^(\d{6}) is your Front Desk code/.exec(texter.sent.at(-1)!.body)![1];
  const sessionOptions = (deps: FrontDeskDeps, token: string | undefined = TOKEN) => ({
    getToken: () => token,
    now: () => NOW.getTime(),
    getDeps: () => deps,
  });
  const signIn = (deps: FrontDeskDeps, body: OwnerSessionRequest, token?: string) =>
    ownerSessionPost(
      new Request(`${ORIGIN}/api/owner/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      sessionOptions(deps, token),
    );
  const formPost = (path: string, fields: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  it("POST /api/owner/code texts a 6-digit code to ownerMobile; { code } signs in once, setting the same cookie as the access code", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter, policies: { ownerMobile: OWNER_MOBILE } });
    const res = await ownerCodePost(new Request(`${ORIGIN}/api/owner/code`, { method: "POST" }), { getDeps: () => deps });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual<OwnerCodeResponse>({ sent: true, sentTo: "•••• 0199", expiresAt: "2026-11-09T17:10:00Z" });
    expect(texter.sent).toHaveLength(1);
    expect(texter.sent[0].to).toBe(OWNER_MOBILE);
    expect(texter.sent[0].body).toMatch(/^\d{6} is your Front Desk code for Hart's Barbers\. It works once, for 10 minutes\.$/);

    const code = codeIn(texter);
    const ok = await signIn(deps, { code });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual<OwnerSessionResponse>({ signedIn: true, expiresAt: "2026-11-10T05:00:00Z" });
    expect(ok.headers.get("set-cookie")?.split("; ")[0]).toBe(`${OWNER_SESSION_COOKIE}=${encodeURIComponent(TOKEN)}`);

    // Single use.
    const again = await signIn(deps, { code });
    expect(again.status).toBe(401);
    expect(((await again.json()) as ApiError).error).toMatchObject({ code: "unauthorized", message: "Wrong or expired code, or it was already used." });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("a code works until 10 minutes after sending, and not after", async () => {
    const texter = recordingTexter();
    const clock = movableClock(NOW);
    const deps = memoryDeps({ texter, clock, policies: { ownerMobile: OWNER_MOBILE } });
    await sendOwnerCode(deps);
    const early = codeIn(texter);
    await sendOwnerCode(deps);
    const late = codeIn(texter);
    clock.advance(10 * MIN - 1);
    expect((await signIn(deps, { code: early })).status).toBe(200);
    clock.advance(1);
    expect((await signIn(deps, { code: late })).status).toBe(401);
  });

  it("a wrong code, or something that isn't six digits, is refused; spaces in a good one are fine", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter, policies: { ownerMobile: OWNER_MOBILE } });
    await sendOwnerCode(deps);
    const code = codeIn(texter);
    const wrong = code === "000000" ? "111111" : "000000";
    for (const bad of [wrong, "12345", "abcdef", "1234567", TOKEN, "\u0000"]) expect((await signIn(deps, { code: bad })).status).toBe(401);
    expect((await signIn(deps, { code: `${code.slice(0, 3)} ${code.slice(3)}` })).status).toBe(200);
    const numeric = await ownerSessionPost(
      new Request(`${ORIGIN}/api/owner/session`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"code":123456}' }),
      sessionOptions(deps),
    );
    expect(numeric.status).toBe(400);
    expect(((await numeric.json()) as ApiError).error.details?.field).toBe("code");
  });

  it("without OWNER_API_TOKEN the code isn't used up: 401 'not set up', and it still works once the token is set", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter, policies: { ownerMobile: OWNER_MOBILE } });
    await sendOwnerCode(deps);
    const code = codeIn(texter);
    const unset = await signIn(deps, { code }, "");
    expect(unset.status).toBe(401);
    expect(((await unset.json()) as ApiError).error.message).toBe("Owner access isn't set up on this deployment.");
    expect((await signIn(deps, { code })).status).toBe(200);
  });

  it("the unlock page's forms: Text me a code → 303 ?code=sent; the code → 303 /console with the cookie, or ?error=code", async () => {
    const texter = recordingTexter();
    const deps = memoryDeps({ texter, policies: { ownerMobile: OWNER_MOBILE } });
    const sent = await ownerCodePost(formPost("/api/owner/code"), { getDeps: () => deps });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(`${ORIGIN}/console/unlock?code=sent`);
    const code = codeIn(texter);

    const wrong = await ownerSessionPost(formPost("/api/owner/session", { code: code === "000000" ? "111111" : "000000" }), sessionOptions(deps));
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get("location")).toBe(`${ORIGIN}/console/unlock?error=code`);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    // The access code's value in the code field is a wrong code, not a sign-in.
    const tokenAsCode = await ownerSessionPost(formPost("/api/owner/session", { code: TOKEN }), sessionOptions(deps));
    expect(tokenAsCode.headers.get("location")).toBe(`${ORIGIN}/console/unlock?error=code`);
    expect(tokenAsCode.headers.get("set-cookie")).toBeNull();

    const ok = await ownerSessionPost(formPost("/api/owner/session", { code }), sessionOptions(deps));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/console`);
    expect(ok.headers.get("set-cookie")?.split("; ")[0]).toBe(`${OWNER_SESSION_COOKIE}=${encodeURIComponent(TOKEN)}`);
  });

  it("can't send: texting off or no ownerMobile → 400 with details.reason; a failed text → 500 send_failed (no number shown)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const post = (deps: FrontDeskDeps, form = false) =>
      ownerCodePost(form ? formPost("/api/owner/code") : new Request(`${ORIGIN}/api/owner/code`, { method: "POST" }), { getDeps: () => deps });

    const off = memoryDeps({ policies: { ownerMobile: OWNER_MOBILE } });
    const offRes = await post(off);
    expect(offRes.status).toBe(400);
    expect(((await offRes.json()) as ApiError).error).toMatchObject({ code: "invalid_request", details: { reason: "texting_off" } });
    expect((await post(off, true)).headers.get("location")).toBe(`${ORIGIN}/console/unlock?error=texting_off`);

    const noMobile = memoryDeps({ texter: recordingTexter() });
    const noMobileRes = await post(noMobile);
    expect(noMobileRes.status).toBe(400);
    expect(((await noMobileRes.json()) as ApiError).error).toMatchObject({ details: { reason: "no_mobile" } });
    expect((await post(noMobile, true)).headers.get("location")).toBe(`${ORIGIN}/console/unlock?error=no_mobile`);

    const failing = memoryDeps({ texter: failingTexter(`Twilio answered HTTP 400: The 'To' number ${OWNER_MOBILE} is not valid.`), policies: { ownerMobile: OWNER_MOBILE } });
    const failedRes = await post(failing);
    expect(failedRes.status).toBe(500);
    const failed = (await failedRes.json()) as ApiError;
    expect(failed.error).toMatchObject({ code: "internal", message: "The text to •••• 0199 didn't go through.", details: { reason: "send_failed" } });
    expect(JSON.stringify(failed)).not.toContain(OWNER_MOBILE);
    expect((await post(failing, true)).headers.get("location")).toBe(`${ORIGIN}/console/unlock?error=send_failed`);
  });

  it("the access code still works, with texting on", async () => {
    const deps = memoryDeps({ texter: recordingTexter(), policies: { ownerMobile: OWNER_MOBILE } });
    const res = await signIn(deps, { token: TOKEN });
    expect(res.status).toBe(200);
  });
});

// ---- Texting off changes nothing ----

describe("texting off (no text sender configured)", () => {
  it("deps: no PHOTON_* or TWILIO_* → texter null; Twilio's three variables → the Twilio sender", () => {
    const warn = () => {};
    expect(createFrontDeskDeps({}, warn).texter).toBeNull();
    const twilio = createFrontDeskDeps({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+12125550101" }, warn);
    expect(twilio.texter?.provider).toBe("twilio");
  });

  it("booking, alerts and unlock behave as before: no texts, texted false, only the log alert, the access code signs in", async () => {
    const deps = memoryDeps({ policies: { ownerMobile: OWNER_MOBILE } });
    const outcome = await hold(deps);
    expect(outcome.texted).toBe(false);
    expect(outcome.booking.customer.phone).toBeUndefined();
    await approveBooking(deps, approvalToken(outcome.booking), {});
    expect(await recorded(deps)).toEqual([["booking_confirmed", "log", null, "logged"]]);
    const res = await ownerSessionPost(
      new Request(`${ORIGIN}/api/owner/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) }),
      { getToken: () => TOKEN, now: () => NOW.getTime(), getDeps: () => deps },
    );
    expect(res.status).toBe(200);
  });
});
