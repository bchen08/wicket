"use client";

import { useState } from "react";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { demoBooking } from "@/lib/mock";

export function GetStarted() {
  const [approved, setApproved] = useState(false);
  return (
    <section
      id="get-started"
      aria-labelledby="start-title"
      className="page-shell section-space"
    >
      <div className="start-panel">
        <div className="max-w-lg">
          <p className="eyebrow text-primary">Meet your new front desk</p>
          <h2 id="start-title" className="section-title mt-4">
            Your next chapter starts
            <br />
            with your next booking.
          </h2>
          <p className="mt-4 max-w-sm text-sm leading-7 text-muted-foreground">
            See the customer approval step for yourself. A real person always
            gets the final say.
          </p>
        </div>
        <div className="w-full max-w-sm rounded-xl border border-border bg-background p-5">
          <p className="eyebrow text-muted-foreground">Interactive example</p>
          <p className="mt-4 text-sm font-medium">{demoBooking.service}</p>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            {demoBooking.business}
            <br />
            {demoBooking.date} · {demoBooking.time}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            {demoBooking.price} total · {demoBooking.deposit} deposit
          </p>
          <div className="mt-5" aria-live="polite">
            {approved ? (
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-primary">
                  <Check className="size-4" aria-hidden="true" /> Example
                  booking approved
                </p>
                <Button
                  variant="link"
                  className="mt-2 px-0"
                  onClick={() => setApproved(false)}
                >
                  Try again{" "}
                  <RotateCcw data-icon="inline-end" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Button
                className="w-full"
                size="lg"
                onClick={() => setApproved(true)}
              >
                Approve example booking{" "}
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="mt-3 text-[10px] leading-5 text-muted-foreground">
            Demo only. No appointment is made or card charged.
          </p>
        </div>
      </div>
    </section>
  );
}
