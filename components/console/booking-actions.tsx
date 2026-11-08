"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Booking, OwnerBookingActionResponse } from "@/lib/types/frontdesk";
import { Button } from "@/components/ui/button";
import { SaveFeedback } from "@/components/console/form-parts";
import { errorFeedback, writeSettings, type Feedback } from "@/components/console/api";
import { allowedBookingActions, confirmationEffect, actionDepositOutcome } from "@/components/console/booking-action-policy";

type Action = "complete" | "no-show" | "cancel";

export function BookingActions({ booking, now }: { booking: Booking; now: number }) {
  const router = useRouter();
  const [clock, setClock] = useState(now);
  const [confirm, setConfirm] = useState<Exclude<Action, "complete"> | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { canFinish, canCancel } = allowedBookingActions(booking, clock);
  const confirmationAllowed = confirm === "cancel" ? canCancel : canFinish;
  const busy = pending || refreshing;
  const effect = confirmationEffect(booking, confirm);

  async function act(action: Action) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const result = await writeSettings<OwnerBookingActionResponse, never>(`bookings/${encodeURIComponent(booking.id)}/${action}`, "POST");
      const label = action === "complete" ? "Booking completed." : action === "no-show" ? "Marked as no-show." : "Booking cancelled. The slot is available again.";
      const failure = result.booking.deposit.actionFailed;
      const outcome = actionDepositOutcome(result);
      setFeedback({ message: `${label} ${outcome}`, saved: !failure });
      setConfirm(null);
      startTransition(() => router.refresh());
    } catch (error) {
      setFeedback(errorFeedback(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <div className="flex flex-col gap-3">
    {(canFinish || canCancel) && <div className="flex flex-wrap gap-2">
      {canFinish && <>
        <Button disabled={busy} onClick={() => void act("complete")}>Complete</Button>
        <Button variant="outline" disabled={busy} onClick={() => { setConfirm("no-show"); setFeedback(null); }}>No-show</Button>
      </>}
      {canCancel && <Button variant="outline" disabled={busy} onClick={() => { setConfirm("cancel"); setFeedback(null); }}>Cancel</Button>}
    </div>}
    {confirm && confirmationAllowed && <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" role="group" aria-label={confirm === "cancel" ? "Confirm cancellation" : "Confirm no-show"}>
      <p className="font-medium">{confirm === "cancel" ? "Cancel this booking?" : "Mark this booking as a no-show?"}</p>
      <p className="text-sm" aria-live="polite">{effect}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={busy} onClick={() => void act(confirm)}>{pending ? "Saving…" : confirm === "cancel" ? "Confirm cancellation" : "Confirm no-show"}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Go back</Button>
      </div>
    </div>}
    {busy && <p role="status" className="text-sm text-muted-foreground">Updating booking…</p>}
    <SaveFeedback feedback={feedback} />
  </div>;
}
