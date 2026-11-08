import type { BookingEvent, BookingEventType } from "@/lib/types/frontdesk";
import { bookingTime } from "@/components/console/booking-deposit";

const descriptions: Record<BookingEventType, string> = {
  booked: "Booking requested",
  approved: "Customer approved the booking",
  declined: "Customer declined the booking",
  expired: "Hold expired and the time became available",
  cancelled: "Booking cancelled",
  completed: "Appointment completed",
  no_show: "Customer marked as a no-show",
  "deposit.paid": "Deposit authorized on the card; booking confirmed",
  "deposit.action_failed": "Deposit could not be captured or released",
};
const actors = { agent: "Booking agent", owner: "Shop owner", customer: "Customer", system: "Automatic update" };

export function BookingHistory({ events }: { events: BookingEvent[] }) {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return <section className="flex flex-col gap-4" aria-labelledby="history-heading">
    <h2 id="history-heading" className="font-serif text-3xl leading-tight">Booking history</h2>
    {!sorted.length ? <p className="text-sm text-muted-foreground">No events recorded yet.</p> : <ol className="flex flex-col divide-y divide-border border-y border-border">
      {sorted.map(event => <li key={event.id} className="flex flex-col gap-2 py-4 text-sm leading-relaxed wrap-anywhere">
        <p className="font-medium">{descriptions[event.type]}</p>
        <p className="text-muted-foreground">{actors[event.actor]} · <time dateTime={event.at} className="font-mono">{bookingTime(event.at)}</time></p>
        {event.type === "booked" && typeof event.data.agentName === "string" && <p>Booked through {event.data.agentName}</p>}
        {event.data.depositEffect === "captured" && <p>{event.data.depositCollected === true ? "Policy: keep the deposit. See the deposit state and any failure below for the outcome." : "Policy: keep the deposit; no deposit was held."}</p>}
        {event.data.depositEffect === "released" && <p>{event.data.depositCollected === true ? "Policy: release the hold. See the deposit state and any failure below for the outcome." : "No money was collected for this change."}</p>}
        {event.type === "deposit.action_failed" && typeof event.data.message === "string" && <p className="text-destructive">{event.data.action === "capture" ? "Capture" : "Release"} failed: {event.data.message}. The money did not move.</p>}
      </li>)}
    </ol>}
  </section>;
}
