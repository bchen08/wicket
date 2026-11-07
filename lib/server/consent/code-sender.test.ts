import { describe, expect, it } from "vitest";
import { createLogCodeSender } from "./code-sender";

describe("log code sender (Ring 1b stub)", () => {
  it("logs one otp.sent line with the last 4 digits and the booking id, never the code or the full number", async () => {
    const lines: string[] = [];
    await createLogCodeSender((line) => lines.push(line)).send({
      phoneE164: "+14015550123",
      code: "987654",
      shopName: "Hart's Barbers",
      bookingId: "7d0c5a62-4b7e-4f6e-9a51-3f0c2b1d9e88",
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: "otp.sent",
      phoneLast4: "0123",
      bookingId: "7d0c5a62-4b7e-4f6e-9a51-3f0c2b1d9e88",
    });
    expect(lines[0]).not.toContain("987654");
    expect(lines[0]).not.toContain("4015550123");
  });
});
