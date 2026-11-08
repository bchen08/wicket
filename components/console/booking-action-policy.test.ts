import { describe, expect, it } from "vitest";
import type { Booking, BookingStatus } from "../../lib/types/frontdesk";
import { allowedBookingActions, confirmationEffect, actionDepositOutcome } from "./booking-action-policy";
import { depositLabel } from "./booking-deposit";

const start = Date.parse("2026-11-08T12:00:00Z");
const booking: Booking = {
  id: "test", shopSlug: "harts", serviceId: "haircut", serviceName: "Haircut", staffId: "dana",
  start: new Date(start).toISOString(), end: new Date(start + 1800000).toISOString(), display: "Sun 8 Nov, 7 am EST",
  status: "confirmed", customer: { displayName: "Test customer", approved: true }, agent: { name: "Test agent", confirmed: false },
  depositCents: 1000, deposit: { amountCents: 1000, state: "held" }, createdAt: new Date(start - 86400000).toISOString(),
};

describe("owner booking actions", () => {
  it("allows finishing exactly at start, never cancelling a started confirmed booking", () => {
    expect(allowedBookingActions(booking, start - 1)).toEqual({ canFinish: false, canCancel: true });
    expect(allowedBookingActions(booking, start)).toEqual({ canFinish: true, canCancel: false });
    expect(allowedBookingActions(booking, start + 1)).toEqual({ canFinish: true, canCancel: false });
  });
  it.each<BookingStatus>(["cancelled", "expired", "completed", "no_show"])("has no actions for %s", status => {
    expect(allowedBookingActions({ ...booking, status }, start + 1)).toEqual({ canFinish: false, canCancel: false });
  });
  it("allows pending approval cancellation but never completion", () => {
    expect(allowedBookingActions({ ...booking, status: "awaiting_approval" }, start + 1)).toEqual({ canFinish: false, canCancel: true });
    expect(allowedBookingActions({ ...booking, status: "awaiting_deposit" }, start - 1)).toEqual({ canFinish: false, canCancel: true });
    expect(allowedBookingActions({ ...booking, status: "awaiting_deposit" }, start + 1)).toEqual({ canFinish: false, canCancel: false });
  });
  it("explains no-show capture and owner cancellation release", () => {
    expect(confirmationEffect(booking, "no-show")).toBe("Keeps the $10 deposit");
    expect(confirmationEffect(booking, "cancel")).toBe("Releases the $10 hold");
    expect(confirmationEffect({ ...booking, deposit: { amountCents: 1000, state: "not_collected" } }, "no-show")).toContain("No money will move");
  });
  it.each([
    ["held", "$10 held"], ["captured", "$10 kept"], ["released", "Hold released"],
    ["not_collected", "Deposit not collected"], ["awaiting_payment", "Waiting for deposit"], ["none", "Deposit not requested yet"],
  ] as const)("labels %s", (state, label) => {
    expect(depositLabel({ amountCents: 1000, state })).toBe(label);
  });
  it("reports actual movement, no collection, and Stripe failure separately", () => {
    expect(actionDepositOutcome({ booking, depositCollected: true, depositEffect: "captured" })).toBe("$10 deposit kept.");
    expect(actionDepositOutcome({ booking, depositCollected: true, depositEffect: "released" })).toBe("Hold released.");
    expect(actionDepositOutcome({ booking, depositCollected: false, depositEffect: "captured" })).toContain("No money moved");
    expect(actionDepositOutcome({ booking: { ...booking, deposit: { ...booking.deposit, actionFailed: { action: "capture", message: "Card error", at: booking.start } } }, depositCollected: true, depositEffect: "captured" })).toBe("Deposit capture failed: Card error. The money did not move.");
  });
});
