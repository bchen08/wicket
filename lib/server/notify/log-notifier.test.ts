import { describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import { customerOf } from "../frontdesk/test-support";
import { createLogNotifier, firstName } from "./log-notifier";

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
  customer: customerOf("Maya Lopez-Hart", false),
  agent: { name: "claude-ai" },
  depositCents: 1000,
  deposit: { amountCents: 1000, state: "held" },
  createdAt: "2026-11-07T12:00:00-05:00",
};

describe("log notifier", () => {
  it("writes one booking.confirmed JSON line with the customer's first name only", async () => {
    const lines: string[] = [];
    await createLogNotifier((line) => lines.push(line)).alertOwner(booking);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: "booking.confirmed",
      id: booking.id,
      shop: "harts",
      service: "haircut",
      start: "2026-11-14T14:30:00-05:00",
      customer_first_name: "Maya",
    });
    expect(lines[0]).not.toContain("Lopez");
  });

  it("takes the first word of a name as the first name", () => {
    expect(firstName("  Maya   Lopez ")).toBe("Maya");
    expect(firstName("Maya")).toBe("Maya");
  });
});
