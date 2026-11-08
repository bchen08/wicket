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
        "rounded-md border px-2 py-1 text-xs wrap-anywhere",
        status === "confirmed"
          ? "border-primary/15 bg-accent text-primary"
          : "border-border bg-muted text-muted-foreground",
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
        "flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-5 wrap-anywhere",
        booking.status === "cancelled" && "bg-muted/40 text-muted-foreground",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{booking.display}</p>
        <StatusBadge status={booking.status} />
      </div>
      <h3 className="text-lg font-medium"><Link href={`/console/bookings/${booking.id}`} className="underline decoration-border underline-offset-4 hover:text-primary">{booking.serviceName}<span className="sr-only"> for {booking.customer.displayName} — view booking details</span></Link></h3>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{booking.customer.displayName}</span>
        {booking.customer.approved && (
          <span className="rounded-md border border-border px-2 py-0.5 text-xs text-primary">
            Customer-approved
          </span>
        )}
      </div>
      {booking.customer.phone && (
        <p className="text-sm">Phone: {booking.customer.phone}</p>
      )}
      <AgentBadge agent={booking.agent} />
      {(booking.status === "awaiting_approval" || booking.status === "awaiting_deposit") && booking.approval && (
        <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
          <p className="text-sm text-muted-foreground">
            Hold expires{" "}
            <time dateTime={booking.approval.expiresAt}>
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
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-medium">
        {title}
        <span className="text-sm font-normal text-muted-foreground">
          ({bookings.length})
        </span>
      </h2>
      {bookings.length ? (
        <ul className="flex flex-col gap-3">
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
