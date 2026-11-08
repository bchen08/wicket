import type { Booking, OwnerBookingActionResponse } from "@/lib/types/frontdesk";
import { depositLabel, money } from "./booking-deposit";

export function allowedBookingActions(booking: Booking, now: number) {
  const started = Date.parse(booking.start) <= now;
  return {
    canFinish: booking.status === "confirmed" && started,
    // Owner cancellations release holds even inside the agent cancellation window.
    canCancel: booking.status === "awaiting_approval" || (!started && (booking.status === "confirmed" || booking.status === "awaiting_deposit")),
  };
}

export function confirmationEffect(booking: Booking, action: "cancel" | "no-show" | null) {
  if (booking.deposit.state !== "held") return "No deposit is held. No money will move.";
  return action === "no-show" ? `Keeps the ${money(booking.deposit.amountCents)} deposit` : `Releases the ${money(booking.deposit.amountCents)} hold`;
}

export function actionDepositOutcome(result: OwnerBookingActionResponse) {
  const failure = result.booking.deposit.actionFailed;
  if (failure) return `Deposit ${failure.action} failed: ${failure.message}. The money did not move.`;
  if (!result.depositCollected) return `${depositLabel(result.booking.deposit)}. No money moved.`;
  if (result.depositEffect === "captured") return `${money(result.booking.deposit.amountCents)} deposit kept.`;
  if (result.depositEffect === "released") return "Hold released.";
  return depositLabel(result.booking.deposit);
}
