import { describe, expect, it, vi } from "vitest";
import type { Booking } from "../../types/frontdesk";
import { customerOf } from "../frontdesk/test-support";
import { ALERT_FROM, alertSubject, alertText, RESEND_URL } from "./email";
import { createNotifier, type OwnerAlert } from "./notifier";

// The owner notifier: which channel an alert takes (email or log), what the email says, and how a failed
// send surfaces. Recording alerts and keeping bookings safe from failures is alertOwner's job (alerts.test.ts).

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
  customer: customerOf("Maya Lopez", true, "+14015550123"),
  agent: { name: "claude-ai" },
  depositCents: 1000,
  createdAt: "2026-11-09T12:00:00-05:00",
};

const alert = (overrides: Partial<OwnerAlert> = {}): OwnerAlert => ({
  kind: "booking_confirmed",
  booking,
  shop: { slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" },
  priceCents: 3500,
  ownerEmail: "dana@example.com",
  cancelledBy: null,
  consoleUrl: "https://emergent.vercel.app/console",
  ...overrides,
});

/** A fetch that answers every call with `response` and remembers the calls. */
function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("createNotifier: which channel", () => {
  it("emails the shop's ownerEmail when RESEND_API_KEY is set", () => {
    const notifier = createNotifier({ resendApiKey: "re_test_123" });
    expect(notifier.route(alert())).toEqual({ channel: "email", recipient: "dana@example.com" });
  });

  it("logs when RESEND_API_KEY isn't set (previews, local), even with an ownerEmail", () => {
    for (const resendApiKey of [undefined, "", "   "]) {
      expect(createNotifier({ resendApiKey }).route(alert())).toEqual({ channel: "log", recipient: null });
    }
  });

  it("logs when the shop has no ownerEmail, even with RESEND_API_KEY", () => {
    expect(createNotifier({ resendApiKey: "re_test_123" }).route(alert({ ownerEmail: null }))).toEqual({
      channel: "log",
      recipient: null,
    });
  });
});

describe("createNotifier: sending", () => {
  it("email: one POST to Resend's API with the key, the onboarding sender, the owner, the subject and the text", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ id: "email-1" }));
    const log = vi.fn();
    const notifier = createNotifier({ resendApiKey: " re_test_123 ", fetch, log });
    const a = alert();
    await notifier.send(a, notifier.route(a));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_URL);
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: "Front Desk <onboarding@resend.dev>",
      to: ["dana@example.com"],
      subject: "New booking: Haircut, Sat 14 Nov 2:00 pm",
      text: alertText(a),
    });
    expect(ALERT_FROM).toBe("Front Desk <onboarding@resend.dev>");
    expect(log).not.toHaveBeenCalled();
  });

  it("log: one JSON line, and no request to Resend", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({}));
    const lines: string[] = [];
    const notifier = createNotifier({ fetch, log: (line) => lines.push(line) });
    const a = alert();
    await notifier.send(a, notifier.route(a));
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "booking.confirmed", id: booking.id, subject: alertSubject(a) });
  });

  it("a refused email throws with Resend's own message", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json(
        { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (owner@example.com)." },
        { status: 403 },
      ),
    );
    const notifier = createNotifier({ resendApiKey: "re_test_123", fetch });
    const a = alert();
    await expect(notifier.send(a, notifier.route(a))).rejects.toThrow(
      "Resend answered HTTP 403: You can only send testing emails to your own email address (owner@example.com).",
    );
  });

  it("a non-JSON error answer and an unreachable Resend throw too", async () => {
    const a = alert();
    const down = createNotifier({ resendApiKey: "k", fetch: fakeFetch(() => new Response("Bad Gateway", { status: 502 })).fetch });
    await expect(down.send(a, down.route(a))).rejects.toThrow("Resend answered HTTP 502: Bad Gateway");

    const unreachable = createNotifier({
      resendApiKey: "k",
      fetch: fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).fetch,
    });
    await expect(unreachable.send(a, unreachable.route(a))).rejects.toThrow("Resend didn't answer: fetch failed");
  });
});

describe("the email", () => {
  it("New booking: subject, then service, time in the shop's zone, name, phone, agent, price and deposit, console link", () => {
    const a = alert();
    expect(alertSubject(a)).toBe("New booking: Haircut, Sat 14 Nov 2:00 pm");
    const text = alertText(a);
    expect(text).toBe(
      [
        "New booking at Hart's Barbers: the customer approved it.",
        "",
        "Service: Haircut",
        "When: Sat 14 Nov, 2:00 pm EST",
        "Customer: Maya Lopez",
        "Phone: +14015550123",
        "Booked by: claude-ai",
        "Price: $35 (deposit $10, not collected yet)",
        "",
        "All bookings: https://emergent.vercel.app/console",
      ].join("\n"),
    );
    expect(text.split("\n").length).toBeLessThan(15);
  });

  it("the subject's time is in the shop's zone, whatever offset the booking carries", () => {
    expect(alertSubject(alert({ booking: { ...booking, start: "2026-11-14T19:00:00Z" } }))).toBe(
      "New booking: Haircut, Sat 14 Nov 2:00 pm",
    );
    expect(alertSubject(alert({ booking: { ...booking, start: "2026-11-14T09:30:00-05:00" } }))).toBe(
      "New booking: Haircut, Sat 14 Nov 9:30 am",
    );
  });

  it("Cancelled: says who cancelled; no phone line without a phone; no deposit when there is none", () => {
    const cancelled: Booking = {
      ...booking,
      serviceName: "Beard trim",
      status: "cancelled",
      customer: customerOf("Lee", false),
      depositCents: 0,
    };
    const byAgent = alert({ kind: "booking_cancelled", booking: cancelled, cancelledBy: "agent", priceCents: 1550 });
    expect(alertSubject(byAgent)).toBe("Cancelled: Beard trim, Sat 14 Nov 2:00 pm");
    const text = alertText(byAgent);
    expect(text.split("\n")[0]).toBe("The agent cancelled a booking at Hart's Barbers. The time is free again.");
    expect(text).not.toContain("Phone:");
    expect(text).toContain("Price: $15.50 (no deposit)");

    const declined = alertText(alert({ kind: "booking_cancelled", booking: cancelled, cancelledBy: "customer" }));
    expect(declined.split("\n")[0]).toBe("The customer declined a booking at Hart's Barbers. The time is free again.");
  });
});
