import {
  CalendarDays,
  Check,
  CreditCard,
  LockKeyhole,
  Scissors,
  ShieldCheck,
} from "lucide-react";
import { demoBooking } from "@/lib/mock";

export function BookingPreview() {
  const booking = demoBooking;
  return (
    <div
      className="booking-stage"
      aria-label="Example of a customer-approved booking"
    >
      <div className="booking-note">
        <span className="size-1.5 rounded-full bg-primary" /> Your next booking,
        taken care of.
      </div>
      <div className="booking-card">
        <div className="flex items-center gap-3 border-b border-border p-6">
          <div className="flex size-10 items-center justify-center rounded-xl bg-surface">
            <Scissors className="size-5" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">
              {booking.business}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {booking.category}
            </p>
          </div>
          <span className="ml-auto flex size-7 items-center justify-center rounded-full bg-accent text-primary">
            <Check className="size-4" aria-hidden="true" />
          </span>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow text-muted-foreground">
              New appointment
            </span>
            <span className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-medium text-primary">
              Confirmed
            </span>
          </div>
          <h2 className="mt-5 text-[23px] font-medium tracking-[-0.04em]">
            {booking.service}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {booking.duration} <span className="mx-1.5">·</span> {booking.price}
          </p>
          <div className="mt-6 flex items-center gap-3 rounded-lg border border-border bg-surface/60 p-3.5">
            <CalendarDays
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="text-xs">
              <p className="font-medium">{booking.date}</p>
              <p className="mt-1 text-muted-foreground">{booking.time}</p>
            </div>
          </div>
          <div className="my-5 flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-surface text-[10px] font-medium">
              {booking.initials}
            </span>
            <div>
              <p className="text-xs font-medium">{booking.customer}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Booked by {booking.agent.toLowerCase()}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2.5 border-t border-border pt-4">
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <ShieldCheck
                className="size-3.5 text-primary"
                aria-hidden="true"
              />{" "}
              Customer-approved{" "}
              <Check
                className="ml-auto size-3 text-primary"
                aria-hidden="true"
              />
            </p>
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Check className="size-3.5 text-primary" aria-hidden="true" />{" "}
              Approved by {booking.customer.split(" ")[0]}{" "}
              <Check
                className="ml-auto size-3 text-primary"
                aria-hidden="true"
              />
            </p>
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <CreditCard
                className="size-3.5 text-primary"
                aria-hidden="true"
              />{" "}
              {booking.deposit} deposit secured{" "}
              <Check
                className="ml-auto size-3 text-primary"
                aria-hidden="true"
              />
            </p>
          </div>
        </div>
        <div className="flex items-center justify-center gap-1.5 rounded-b-xl border-t border-border bg-surface/40 py-3 text-[9px] text-muted-foreground">
          <LockKeyhole className="size-2.5" aria-hidden="true" /> Securely
          coordinated by Front Desk
        </div>
      </div>
      <div className="booking-receipt">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="text-xs font-medium">One less thing on your list.</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Customer-approved. On your calendar.
          </p>
        </div>
      </div>
      <p className="mt-6 text-center font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        An example booking. A better kind of busy.
      </p>
    </div>
  );
}
