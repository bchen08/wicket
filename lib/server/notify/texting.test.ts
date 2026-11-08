import { describe, expect, it, vi } from "vitest";
import type { Booking } from "../../types/frontdesk";
import { customerOf } from "../frontdesk/test-support";
import type { OwnerAlert } from "./notifier";
import { PHOTON_API } from "./photon";
import { maskPhone, textingMode, textSenderFrom } from "./texting";
import { approvalLinkText, ownerAlertText, ownerCodeText } from "./texts";
import { twilioMessagesUrl } from "./twilio";

// The text senders on their own: which one the environment picks, exactly what each sends to its provider
// (with a fake fetch), how a refusal surfaces, and what the texts say. How Front Desk uses them (book, owner
// alerts, sign-in codes) is in lib/server/frontdesk/texting.test.ts.

const PHOTON = { PHOTON_API_KEY: "pho_sk_test", PHOTON_PROJECT_ID: "pho_prj_00000000000000000000000001", PHOTON_LINE: "+12125550100" };
const TWILIO = { TWILIO_ACCOUNT_SID: "AC0123", TWILIO_AUTH_TOKEN: "auth-secret", TWILIO_FROM: "+12125550101" };
const TO = "+14015550123";

/** A fetch that answers each call with the next of `responses` (the last one repeats) and remembers the calls. */
function fakeFetch(...responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses[Math.min(calls.length, responses.length) - 1]();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("which sender: the environment decides", () => {
  it("Photon when all three PHOTON_* are set, even with Twilio set too", () => {
    expect(textingMode(PHOTON)).toBe("photon");
    expect(textingMode({ ...PHOTON, ...TWILIO })).toBe("photon");
    expect(textSenderFrom({ ...PHOTON, ...TWILIO })?.provider).toBe("photon");
  });

  it("Twilio when all three TWILIO_* are set and Photon isn't", () => {
    expect(textingMode(TWILIO)).toBe("twilio");
    expect(textSenderFrom(TWILIO)?.provider).toBe("twilio");
  });

  it("off with neither, or with one sender only partly set (blank counts as unset)", () => {
    expect(textingMode({})).toBe("off");
    expect(textSenderFrom({})).toBeNull();
    expect(textingMode({ ...PHOTON, PHOTON_LINE: " " })).toBe("off");
    expect(textingMode({ TWILIO_ACCOUNT_SID: "AC0123", TWILIO_AUTH_TOKEN: "x" })).toBe("off");
    expect(textSenderFrom({ ...TWILIO, TWILIO_FROM: "" })).toBeNull();
  });
});

describe("Twilio", () => {
  it("one form POST to the account's Messages.json with Basic auth: To, Body and From", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ sid: "SM1", status: "queued" }, { status: 201 }));
    await textSenderFrom({ ...TWILIO, TWILIO_ACCOUNT_SID: " AC0123 " }, fetch)!.send(TO, "Hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC0123/Messages.json");
    expect(calls[0].url).toBe(twilioMessagesUrl("AC0123"));
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("AC0123:auth-secret").toString("base64")}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ To: TO, Body: "Hello", From: "+12125550101" });
  });

  it("a Messaging Service SID (MG…) goes as MessagingServiceSid instead of From", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ sid: "SM1" }, { status: 201 }));
    await textSenderFrom({ ...TWILIO, TWILIO_FROM: "MG0123" }, fetch)!.send(TO, "Hello");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ To: TO, Body: "Hello", MessagingServiceSid: "MG0123" });
  });

  it("a refusal throws with Twilio's message; an unreachable Twilio throws too", async () => {
    const refused = fakeFetch(() =>
      Response.json({ code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 }, { status: 400 }),
    );
    await expect(textSenderFrom(TWILIO, refused.fetch)!.send(TO, "Hi")).rejects.toThrow(
      "Twilio answered HTTP 400: The 'To' number is not a valid phone number.",
    );
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(textSenderFrom(TWILIO, down.fetch)!.send(TO, "Hi")).rejects.toThrow("Twilio didn't answer: fetch failed");
  });
});

describe("Photon (iMessage, HTTP API)", () => {
  const SENDER = "pho_usr_00000000000000000000000001";
  const PERSON = "pho_usr_00000000000000000000000002";
  const SPACE = "pho_spc_00000000000000000000000001";
  const answers = () =>
    fakeFetch(
      () => Response.json({ id: SENDER, kind: "agent" }),
      () => Response.json({ id: PERSON, kind: "human" }, { status: 201 }),
      () => Response.json({ id: SPACE }, { status: 201 }),
      () => Response.json({ id: "pho_msg_1", status: "dispatched" }, { status: 202 }),
      // A second send: the person, the space, the message (the sender is remembered).
      () => Response.json({ id: PERSON }),
      () => Response.json({ id: SPACE }),
      () => Response.json({ id: "pho_msg_2", status: "dispatched" }, { status: 202 }),
    );

  it("creates or gets the line's user and the person's, then the chat, then sends the text, with the Bearer key", async () => {
    const { fetch, calls } = answers();
    await textSenderFrom(PHOTON, fetch)!.send(TO, "Approve or decline: https://x/approve/abc");
    const project = `${PHOTON_API}/v1/projects/${PHOTON.PHOTON_PROJECT_ID}`;
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", `${project}/users`],
      ["POST", `${project}/users`],
      ["POST", `${project}/spaces`],
      ["POST", `${project}/messages`],
    ]);
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { platform: "imessage", handle: "+12125550100" },
      { platform: "imessage", handle: TO },
      { platform: "imessage", participantIds: [SENDER, PERSON] },
      { spaceId: SPACE, senderId: SENDER, content: { type: "text", format: "plain", text: "Approve or decline: https://x/approve/abc" } },
    ]);
    for (const c of calls) expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer pho_sk_test");
    // Photon requires an Idempotency-Key on spaces and messages: a fresh one each call.
    const keys = calls.map((c) => new Headers(c.init.headers).get("idempotency-key"));
    expect(keys[0]).toBeNull();
    expect(keys[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[2]).not.toBe(keys[3]);
  });

  it("remembers the line's user after the first send", async () => {
    const { fetch, calls } = answers();
    const sender = textSenderFrom(PHOTON, fetch)!;
    await sender.send(TO, "one");
    await sender.send(TO, "two");
    expect(calls).toHaveLength(7);
    expect(JSON.parse(String(calls[4].init.body))).toEqual({ platform: "imessage", handle: TO });
  });

  it("a refusal throws with Photon's code and detail (problem+json)", async () => {
    const { fetch } = fakeFetch(
      () => Response.json({ id: SENDER }),
      () => Response.json({ id: PERSON }),
      () =>
        Response.json(
          { code: "SHARED_LINE_INBOUND_REQUIRED", status: 403, title: "Forbidden", detail: "The peer hasn't messaged this line." },
          { status: 403, headers: { "content-type": "application/problem+json" } },
        ),
    );
    await expect(textSenderFrom(PHOTON, fetch)!.send(TO, "Hi")).rejects.toThrow(
      "Photon answered HTTP 403: SHARED_LINE_INBOUND_REQUIRED: The peer hasn't messaged this line.",
    );
  });

  it("an answer without an id is an error, not a silent success", async () => {
    const { fetch } = fakeFetch(() => Response.json({}));
    await expect(textSenderFrom(PHOTON, fetch)!.send(TO, "Hi")).rejects.toThrow("Photon answered without an id for the line (PHOTON_LINE).");
  });
});

describe("what the texts say", () => {
  const booking: Booking = {
    id: "7d0c5a62-4b7e-4f6e-9a51-3f0c2b1d9e88",
    shopSlug: "harts",
    serviceId: "haircut",
    serviceName: "Haircut",
    staffId: "dana",
    start: "2026-11-14T14:00:00-05:00",
    end: "2026-11-14T14:30:00-05:00",
    display: "Sat 14 Nov, 2:00 pm EST",
    status: "confirmed",
    customer: customerOf("Maya Lopez", true, TO),
    agent: { name: "claude-ai", confirmed: false },
    depositCents: 0,
    deposit: { amountCents: 0, state: "none" },
    createdAt: "2026-11-09T12:00:00-05:00",
  };
  const alert = (overrides: Partial<OwnerAlert> = {}): OwnerAlert => ({
    kind: "booking_confirmed",
    booking,
    shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
    priceCents: 3500,
    ownerEmail: null,
    cancelledBy: null,
    consoleUrl: "https://emergent.vercel.app/console",
    ...overrides,
  });

  it("the approval link: who asked, the shop, the service and time, and the link", () => {
    expect(
      approvalLinkText({
        agentName: "claude-ai",
        shopName: "Hart's Barbers",
        serviceName: "Haircut",
        display: "Sat 14 Nov, 2:00 pm EST",
        url: "https://emergent.vercel.app/approve/abc",
      }),
    ).toBe("claude-ai asked Hart's Barbers to book Haircut on Sat 14 Nov, 2:00 pm EST for you. Approve or decline: https://emergent.vercel.app/approve/abc");
  });

  it("owner alerts: new booking, declined, cancelled by the agent", () => {
    expect(ownerAlertText(alert())).toBe(
      "New booking: Haircut, Sat 14 Nov 2:00 pm, Maya Lopez (booked by claude-ai). All bookings: https://emergent.vercel.app/console",
    );
    expect(ownerAlertText(alert({ kind: "booking_cancelled", cancelledBy: "customer" }))).toBe(
      "Cancelled: Haircut, Sat 14 Nov 2:00 pm, Maya Lopez (the customer declined). All bookings: https://emergent.vercel.app/console",
    );
    expect(ownerAlertText(alert({ kind: "booking_cancelled", cancelledBy: "agent" }))).toBe(
      "Cancelled: Haircut, Sat 14 Nov 2:00 pm, Maya Lopez (claude-ai cancelled). All bookings: https://emergent.vercel.app/console",
    );
  });

  it("the sign-in code, and a masked number", () => {
    expect(ownerCodeText("042917", "Hart's Barbers")).toBe("042917 is your Front Desk code for Hart's Barbers. It works once, for 10 minutes.");
    expect(maskPhone(TO)).toBe("•••• 0123");
  });
});
