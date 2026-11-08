/* eslint-disable @next/next/no-html-link-for-pages -- Native document navigation is intentional for the no-JavaScript booking flow. */
import type { BookingPageResponse } from "@/lib/types/web-booking";
import { cn } from "@/components/utils";
import {
  BookingForm,
  ShopPhone,
} from "@/components/public-booking/booking-form";
import { agentLinks } from "@/components/public-booking/load-booking-page";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);
const commonErrors: Record<string, string> = {
  slot_taken: "That time was just taken. Pick another one.",
  outside_hours:
    "That time is outside the shop’s available hours. Pick another one.",
  too_soon: "That time is too soon to book. Choose a later time.",
};

export function BookingContent({
  data,
  slug,
  serviceId,
  errorCode,
  message,
}: {
  data: BookingPageResponse;
  slug: string;
  serviceId?: string;
  errorCode?: string;
  message?: string;
}) {
  const selected =
    data.services.find((service) => service.id === serviceId) ??
    data.services[0];
  const links = agentLinks(data.bookUrl, slug);
  const error = errorCode
    ? (commonErrors[errorCode] ??
      message ??
      "We couldn’t hold that time. Please choose another time and try again.")
    : undefined;
  return (
    <main
      id="booking"
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12"
    >
      <header className="flex flex-col gap-4">
        <a
          href="/"
          className="w-fit text-xs font-medium uppercase tracking-widest text-primary"
        >
          Front Desk
        </a>
        <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
          {data.shop.name}
        </h1>
        <p className="max-w-xl text-base leading-relaxed">
          Book an appointment. Nothing is booked until you approve it from the
          link you&apos;ll get.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          AI agents: you can also book through our{" "}
          <a
            className="text-primary underline underline-offset-4"
            href={links.mcp}
          >
            MCP endpoint
          </a>{" "}
          or follow the instructions at{" "}
          <a
            className="text-primary underline underline-offset-4"
            href={links.instructions}
          >
            agents.md
          </a>
          .
        </p>
      </header>
      {data.policies.paused ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-6 text-lg leading-relaxed"
        >
          {data.shop.name} isn&apos;t taking online bookings right now. Call{" "}
          <ShopPhone phone={data.policies.phone} />.
        </p>
      ) : (
        <>
          <section
            aria-labelledby="choose-service"
            className="flex flex-col gap-4"
          >
            <h2 id="choose-service" className="text-xl font-medium">
              1. Choose a service
            </h2>
            <nav aria-label="Services" className="flex flex-col gap-3">
              {data.services.map((service) => (
                <a
                  key={service.id}
                  href={`/${encodeURIComponent(slug)}?service=${encodeURIComponent(service.id)}`}
                  aria-current={
                    selected?.id === service.id ? "true" : undefined
                  }
                  className={cn(
                    "flex min-h-14 items-center rounded-xl border px-4 py-4 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    selected?.id === service.id
                      ? "border-primary bg-accent font-medium text-primary"
                      : "border-border bg-card hover:border-primary",
                  )}
                >
                  {`${service.name} · ${service.durationMin} min · ${money(service.priceCents)} · ${money(service.depositCents)} deposit`}
                  {selected?.id === service.id && (
                    <span className="sr-only"> (selected)</span>
                  )}
                </a>
              ))}
            </nav>
          </section>
          {selected ? (
            <BookingForm data={data} service={selected} error={error} />
          ) : (
            <p>
              No services are available to book right now. Call{" "}
              <ShopPhone phone={data.policies.phone} />.
            </p>
          )}
        </>
      )}
      <footer className="border-t border-border pt-6 text-xs text-muted-foreground">
        Bookings powered by{" "}
        <a href="/" className="underline underline-offset-4">
          Front Desk
        </a>
      </footer>
    </main>
  );
}
