import { describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import { customerOf } from "../frontdesk/test-support";
import { alertLogLine, firstName } from "./log-notifier";
import type { OwnerAlert } from "./notifier";

const booking: Booking = {
  id: "7d0c5a62-4b7e-4f6e-9a51-3f0c2b1d9e88",
  shopSlug: "harts",
  serviceId: "haircut",
  serviceName: "Haircut",
  staffId: "dana",
  start: "2026-11-14T14:30:00-05:00",
  end: "2026-11-14T15:00:00-05:00",
  display: "Sat 14 Nov, 2:30 pm EST",
  status: "confirmed",
  customer: customerOf("Maya Lopez-Hart", true, "+14015550123"),
  agent: { name: "claude-ai" },
  depositCents: 1000,
  deposit: { amountCents: 1000, state: "held" },
  createdAt: "2026-11-07T12:00:00-05:00",
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

describe("log channel", () => {
  it("writes one booking.confirmed JSON line with the customer's first name only", () => {
    const line = alertLogLine(alert());
    expect(JSON.parse(line)).toEqual({
      event: "booking.confirmed",
      id: booking.id,
      shop: "harts",
      service: "haircut",
      start: "2026-11-14T14:30:00-05:00",
      customer_first_name: "Maya",
      subject: "New booking: Haircut, Sat 14 Nov 2:30 pm",
    });
    expect(line).not.toContain("Lopez");
    expect(line).not.toContain("+1401");
    expect(line).not.toContain("dana@example.com");
  });

  it("writes booking.cancelled with who cancelled it", () => {
    const cancelled = { ...booking, status: "cancelled" as const };
    expect(JSON.parse(alertLogLine(alert({ kind: "booking_cancelled", booking: cancelled, cancelledBy: "customer" })))).toMatchObject({
      event: "booking.cancelled",
      cancelled_by: "customer",
      subject: "Cancelled: Haircut, Sat 14 Nov 2:30 pm",
    });
  });

  it("takes the first word of a name as the first name", () => {
    expect(firstName("  Maya   Lopez ")).toBe("Maya");
    expect(firstName("Maya")).toBe("Maya");
  });
});
