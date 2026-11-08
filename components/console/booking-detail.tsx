import type { BookingDetailResponse, ServicesResponse } from "@/lib/types/frontdesk";
import { loadSettings } from "@/components/console/load-settings";
import { errorFeedback } from "@/components/console/api";
import { SaveFeedback } from "@/components/console/form-parts";
import { StatusBadge } from "@/components/owner-booking-card";
import { BookingActions } from "@/components/console/booking-actions";
import { BookingDepositDisplay, bookingTime, money } from "@/components/console/booking-deposit";
import { BookingHistory } from "@/components/console/booking-history";
import { CopyApprovalLink } from "@/components/copy-approval-link";
import { RefreshBookings } from "@/components/refresh-bookings";
import { AgentBadge } from "@/components/console/agent-badge";

export async function BookingDetail({ id }: { id: string }) {
  let data: BookingDetailResponse;
  try {
    data = await loadSettings<BookingDetailResponse>(`bookings/${encodeURIComponent(id)}`);
  } catch (error) {
    return <div className="flex flex-col gap-4"><h1 className="text-2xl font-medium">Could not load booking</h1><SaveFeedback feedback={errorFeedback(error)} /><RefreshBookings /></div>;
  }
  const services = await loadSettings<ServicesResponse>("services").catch(() => null);
  const { booking, events } = data;
  const service = services?.services.find(item => item.id === booking.serviceId);
  // Read the clock only after the uncached booking request.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const details: [string, React.ReactNode][] = [
    ["Customer", booking.customer.displayName],
    ["Phone", booking.customer.phone ?? "Not provided"],
    ["Booked through", <AgentBadge key="agent" agent={booking.agent} showClientId />],
    ["Customer approval", booking.customer.approved ? "Approved" : "Not approved"],
    ["Service", booking.serviceName],
    ["Appointment", booking.display],
    ["Ends", bookingTime(booking.end)],
    ["Current service price", service ? money(service.priceCents) : "Unavailable"],
  ];
  return <>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2"><p className="eyebrow text-primary">Booking detail</p><h1 className="text-3xl font-medium tracking-tight">{booking.customer.displayName}</h1><p className="text-muted-foreground">{booking.serviceName} · {booking.display}</p></div>
      <RefreshBookings />
    </header>
    <section className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5 sm:p-6" aria-label="Booking details">
      <div className="self-start"><StatusBadge status={booking.status} /></div>
      <dl className="flex flex-col divide-y divide-border">
        {details.map(([label, value]) => <div key={label} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-5"><dt className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt><dd className="min-w-0 wrap-anywhere">{value}</dd></div>)}
      </dl>
      <BookingDepositDisplay deposit={booking.deposit} />
      {(booking.status === "awaiting_approval" || booking.status === "awaiting_deposit") && booking.approval && <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <a href={booking.approval.url} className="w-fit text-sm text-primary underline underline-offset-4">Open customer approval link</a>
        <p className="text-sm text-muted-foreground">Hold expires <time dateTime={booking.approval.expiresAt}>{bookingTime(booking.approval.expiresAt)}</time></p>
        <CopyApprovalLink url={booking.approval.url} />
      </div>}
      <BookingActions booking={booking} now={now} />
    </section>
    <BookingHistory events={events} />
  </>;
}
