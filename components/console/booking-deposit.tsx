import type { BookingDeposit } from "@/lib/types/deposits";
import { DateTime } from "luxon";

export const money = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0,
}).format(cents / 100);

export function bookingTime(value: string) {
  return DateTime.fromISO(value, { setZone: true }).toFormat("ccc d LLL, h:mm a 'UTC'ZZ");
}

export function depositLabel(deposit: BookingDeposit): string {
  switch (deposit.state) {
    case "held": return `${money(deposit.amountCents)} held`;
    case "captured": return `${money(deposit.amountCents)} kept`;
    case "released": return "Hold released";
    case "not_collected": return "Deposit not collected";
    case "awaiting_payment": return "Waiting for deposit";
    case "none": return deposit.amountCents ? "Deposit not requested yet" : "No deposit required";
  }
}

export function BookingDepositDisplay({ deposit }: { deposit: BookingDeposit }) {
  return <div className="flex flex-col gap-1 text-sm">
    <p>{depositLabel(deposit)}</p>
    {deposit.state === "awaiting_payment" && deposit.payBy && <p className="text-muted-foreground">Pay by <time dateTime={deposit.payBy}>{bookingTime(deposit.payBy)}</time></p>}
    {deposit.actionFailed && <p role="alert" className="text-destructive">Deposit {deposit.actionFailed.action === "capture" ? "capture" : "release"} failed: {deposit.actionFailed.message}. The booking changed, but the money did not move.</p>}
  </div>;
}
