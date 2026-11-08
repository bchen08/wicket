import { approvalText, shopAlert, slip } from "@/lib/mock";

export function AppointmentSlip() {
  return (
    <figure
      aria-label="Example appointment slip"
      className="w-full max-w-sm border border-foreground/80 bg-background px-6 py-7 font-mono text-sm"
    >
      <div className="flex flex-col items-center gap-1 border-b border-dashed border-foreground/40 pb-5 text-center">
        <p className="font-serif text-2xl">{"Hart's Barbers"}</p>
        <p className="text-xs text-muted-foreground">Appointment</p>
      </div>
      <dl className="flex flex-col gap-3 border-b border-dashed border-foreground/40 py-5">
        {slip.lines.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className="text-right">{line.value}</dd>
          </div>
        ))}
      </dl>
      <dl className="flex flex-col gap-3 pt-5">
        {slip.footer.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className="text-right">{line.value}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}

export function AskBubble() {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <p className="max-w-xs rounded-2xl rounded-br-sm bg-foreground px-4 py-3 text-sm leading-relaxed text-background">
        {"Book me a haircut at Hart's Saturday afternoon, under $40."}
      </p>
      <span className="text-xs text-muted-foreground">To Claude</span>
    </div>
  );
}

export function ApprovalText() {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="max-w-xs rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm leading-relaxed">
        {approvalText}{" "}
        <span className="break-all underline underline-offset-2">emergent.vercel.app/approve/…</span>
      </p>
      <span className="text-xs text-muted-foreground">Text message</span>
    </div>
  );
}

export function ApprovalCard() {
  return (
    <div className="flex max-w-xs flex-col gap-4 border-t border-b border-border py-4">
      <div className="flex flex-col gap-1">
        <p className="font-serif text-lg">Approve your booking</p>
        <p className="font-mono text-xs text-muted-foreground">Haircut · Sat 14 Nov, 2:30 pm · $35</p>
      </div>
      <span
        aria-hidden="true"
        className="inline-flex h-10 w-fit items-center rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground"
      >
        Approve
      </span>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Then a <span className="font-mono">$10.00</span> hold on Stripe Checkout.
      </p>
    </div>
  );
}

export function ShopNotice() {
  return (
    <div className="flex max-w-sm flex-col gap-3 font-mono text-xs">
      <p className="border-b border-border pb-3">
        <span className="text-muted-foreground">Text + email · </span>
        {shopAlert}
      </p>
      <p className="flex flex-wrap justify-between gap-x-4 gap-y-1">
        <span>Sat 2:30 pm · Haircut</span>
        <span className="text-muted-foreground">Claude · verified agent</span>
      </p>
    </div>
  );
}
