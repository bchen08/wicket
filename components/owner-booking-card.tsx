import type { Booking, BookingStatus } from "@/lib/types/frontdesk";
import { DateTime } from "luxon";
import { cn } from "@/components/utils";
import { CopyApprovalLink } from "@/components/copy-approval-link";

const STATUS_LABELS: Record<BookingStatus, string> = {
  awaiting_approval: "Awaiting approval",
  awaiting_deposit: "Awaiting deposit",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  expired: "Expired",
  completed: "Completed",
  no_show: "No-show",
};

function StatusBadge({ status }: { status: BookingStatus }) {
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

function BookingCard({ booking }: { booking: Booking }) {
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
      <h3 className="text-lg font-medium">{booking.serviceName}</h3>
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
      <p className="text-sm text-muted-foreground">via {booking.agent.name}</p>
      {booking.status === "awaiting_approval" && booking.approval && (
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
      {booking.depositCents > 0 && (
        <p className="border-t border-border pt-3 text-sm text-muted-foreground">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: booking.depositCents % 100 ? 2 : 0,
          }).format(booking.depositCents / 100)}{" "}
          deposit · not collected yet
        </p>
      )}
    </article>
  );
}

export function BookingGroup({
  title,
  bookings,
}: {
  title: string;
  bookings: Booking[];
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
              <BookingCard booking={booking} />
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
