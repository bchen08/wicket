import {
  ArrowDown,
  ArrowRight,
  Check,
  CreditCard,
  PlugZap,
  ShieldCheck,
  Scissors,
  Flower2,
  Stethoscope,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BookingPreview } from "@/components/booking-preview";
import { features, steps } from "@/lib/mock";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="page-shell hero-section">
      <div className="hero-copy">
        <p className="eyebrow flex items-center gap-2.5">
          <span className="size-1.5 rounded-full bg-primary" /> A new way to
          fill your calendar
        </p>
        <h1
          id="hero-title"
          className="mt-7 text-[clamp(3.5rem,6.3vw,5.6rem)] leading-[1.06] font-medium tracking-[-0.065em]"
        >
          Let AI agents
          <br />
          book your
          <br />
          <span className="text-primary">business.</span>
        </h1>
        <p className="mt-6 max-w-[410px] text-[15px] leading-[1.85] text-muted-foreground">
          Your next customer has an AI assistant. Let it book you in seconds.
          Every booking is verified, customer-approved, and can be backed by a
          deposit. Set your hours once. We&apos;ll take it from there.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-5">
          <Button asChild size="lg">
            <a href="/console">
              Get started{" "}
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </a>
          </Button>
          <a
            href="#how-it-works"
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium hover:text-primary"
          >
            See how it works{" "}
            <ArrowDown className="size-3.5" aria-hidden="true" />
          </a>
        </div>
        <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <Check className="size-3.5 text-primary" aria-hidden="true" /> Your
          business. Your hours. Your rules.
        </p>
      </div>
      <BookingPreview />
    </section>
  );
}

export function BusinessStrip() {
  const businesses = [
    { icon: Scissors, label: "Barbershops" },
    { icon: Flower2, label: "Salons & spas" },
    { icon: Stethoscope, label: "Independent clinics" },
    { icon: Sparkles, label: "And businesses like yours" },
  ];
  return (
    <section
      aria-label="Made for independent businesses"
      className="border-y border-border bg-surface/60"
    >
      <div className="page-shell flex flex-col items-center justify-between gap-6 py-7 lg:flex-row">
        <p className="text-xs text-muted-foreground">
          Built for local. Ready for what&apos;s next.
        </p>
        <div className="flex flex-wrap justify-center gap-x-8 gap-y-4">
          {businesses.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="flex items-center gap-2.5 text-xs font-medium"
            >
              <Icon
                className="size-4 text-muted-foreground"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Features() {
  const icons = [PlugZap, ShieldCheck, CreditCard];
  return (
    <section
      id="why-front-desk"
      aria-labelledby="features-title"
      className="page-shell section-space"
    >
      <div className="text-center">
        <p className="eyebrow text-primary">
          Less admin. More of what you love.
        </p>
        <h2 id="features-title" className="section-title mt-4">
          A fuller calendar. A lighter workload.
        </h2>
        <p className="mt-4 text-sm leading-7 text-muted-foreground">
          All the opportunity of AI. None of the uncertainty.
        </p>
      </div>
      <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
        {features.map((feature, i) => {
          const Icon = icons[i];
          return (
            <article key={feature.title} className="feature-block">
              <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-primary/10 bg-accent">
                <Icon
                  className="size-5 text-primary"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-base font-medium tracking-[-0.025em]">
                {feature.title}
              </h3>
              <p className="mt-3 max-w-sm text-sm leading-7 text-muted-foreground">
                {feature.description}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className="border-y border-border bg-surface/60"
    >
      <div className="page-shell section-space">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <p className="eyebrow text-primary">Simple by design</p>
            <h2 id="how-title" className="section-title mt-4">
              You run your business.
              <br />
              We handle the handoff.
            </h2>
          </div>
          <p className="max-w-xs text-sm leading-7 text-muted-foreground">
            No new inbox to manage. No conversations to chase. Just appointments
            you can count on.
          </p>
        </div>
        <ol className="mt-12 grid gap-9 md:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step.title}>
              <span className="font-mono text-xs text-primary">0{i + 1}</span>
              <h3 className="mt-4 text-base font-medium">{step.title}</h3>
              <p className="mt-3 max-w-xs text-sm leading-7 text-muted-foreground">
                {step.description}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
