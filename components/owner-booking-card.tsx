import type { Booking, BookingStatus } from "@/lib/types/frontdesk";
import { DateTime } from "luxon";
import { cn } from "@/components/utils";
import { CopyApprovalLink } from "@/components/copy-approval-link";
import Link from "next/link";
import { BookingActions } from "@/components/console/booking-actions";
import { BookingDepositDisplay } from "@/components/console/booking-deposit";
import { AgentBadge } from "@/components/console/agent-badge";

const STATUS_LABELS: Record<BookingStatus, string> = {
  awaiting_approval: "Awaiting approval",
  awaiting_deposit: "Awaiting deposit",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  expired: "Expired",
  completed: "Completed",
  no_show: "No-show",
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-2 py-0.5 text-xs wrap-anywhere",
        status === "confirmed"
          ? "border-foreground text-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function BookingCard({ booking, now }: { booking: Booking; now: number }) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-3 border-t border-border py-6 wrap-anywhere",
        booking.status === "cancelled" && "text-muted-foreground",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm">{booking.display}</p>
        <StatusBadge status={booking.status} />
      </div>
      <h3 className="font-serif text-2xl leading-tight"><Link href={`/console/bookings/${booking.id}`} className="underline-offset-4 hover:underline">{booking.serviceName}<span className="sr-only"> for {booking.customer.displayName} — view booking details</span></Link></h3>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{booking.customer.displayName}</span>
        {booking.customer.approved && (
          <span className="rounded-sm border border-border px-2 py-0.5 text-xs">
            Customer-approved
          </span>
        )}
      </div>
      {booking.customer.phone && (
        <p className="text-sm">Phone: <span className="font-mono">{booking.customer.phone}</span></p>
      )}
      <AgentBadge agent={booking.agent} />
      {(booking.status === "awaiting_approval" || booking.status === "awaiting_deposit") && booking.approval && (
        <div className="flex flex-col gap-3 border-t border-dashed border-border pt-3">
          <p className="text-sm text-muted-foreground">
            Hold expires{" "}
            <time dateTime={booking.approval.expiresAt} className="font-mono">
              {DateTime.fromISO(booking.approval.expiresAt, {
                setZone: true,
              }).toFormat("ccc d LLL, h:mm a 'UTC'ZZ")}
            </time>
          </p>
          <CopyApprovalLink
            key={booking.approval.url}
            url={booking.approval.url}
          />
        </div>
      )}
      <div className="border-t border-border pt-3">
        <BookingDepositDisplay deposit={booking.deposit} />
      </div>
      <BookingActions booking={booking} now={now} />
    </article>
  );
}

export function BookingGroup({
  title,
  bookings,
  now,
}: {
  title: string;
  bookings: Booking[];
  now: number;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-4">
      <h2 className="flex items-baseline gap-2 font-serif text-3xl leading-tight">
        {title}
        <span className="font-mono text-sm text-muted-foreground">
          ({bookings.length})
        </span>
      </h2>
      {bookings.length ? (
        <ul className="flex flex-col border-b border-border">
          {bookings.map((booking) => (
            <li key={booking.id}>
              <BookingCard booking={booking} now={now} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No {title.toLowerCase()} bookings.
        </p>
      )}
    </section>
  );
}
