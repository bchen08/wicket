import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  AppointmentSlip,
  ApprovalCard,
  ApprovalText,
  AskBubble,
  ShopNotice,
} from "@/components/booking-preview";
import { agentEndpoints, bookCall, contactHref, menu, shop } from "@/lib/mock";

// The landing page is printed paper and ink; the console keeps its own palette. The accent is reserved for approval.
export const paperTheme = {
  "--background": "#f5f1e8",
  "--foreground": "#1d1b18",
  "--surface": "#e9e3d6",
  "--muted-foreground": "#5d574d",
  "--border": "#d6cdbb",
  "--primary": "#1d1b18",
  "--primary-foreground": "#f5f1e8",
  "--secondary": "#e9e3d6",
  "--secondary-foreground": "#1d1b18",
  "--accent": "#b3361d",
  "--accent-foreground": "#f5f1e8",
  "--ring": "#1d1b18",
  "--font-serif": "var(--font-newsreader), Georgia, serif",
} as CSSProperties;

const shell = "mx-auto w-full max-w-5xl px-6 sm:px-10";

export function Masthead() {
  return (
    <header className="border-b border-border">
      <div className={`${shell} flex min-h-16 items-center justify-between gap-4`}>
        <Link href="/" className="font-serif text-xl">
          Front Desk
        </Link>
        <Link
          href={shop.path}
          className="text-sm underline-offset-4 hover:underline"
        >
          {"Hart's booking page"}
        </Link>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className={`${shell} py-16 sm:py-24`}>
      <div className="flex flex-col gap-14 md:flex-row md:items-center md:justify-between md:gap-12">
        <div className="flex max-w-xl flex-col gap-6">
          <h1
            id="hero-title"
            className="font-serif text-4xl leading-tight text-balance sm:text-5xl lg:text-6xl"
          >
            {"Your customers' AI assistants can book your shop now."}
          </h1>
          <p className="max-w-md text-base leading-relaxed text-muted-foreground text-pretty">
            The customer approves every booking by text, and a card deposit
            stops no-shows.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href={shop.path}>{"Book a test haircut at Hart's"}</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={contactHref}>Set up your shop</a>
            </Button>
          </div>
        </div>
        <AppointmentSlip />
      </div>
    </section>
  );
}

function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="font-serif text-3xl leading-tight sm:text-4xl">
      {children}
    </h2>
  );
}

const story = [
  {
    time: "2:14 pm",
    text: "Someone asks Claude for a haircut.",
    artifact: <AskBubble />,
  },
  {
    time: "2:14 pm",
    text: "Front Desk holds 2:30 and texts them a link to approve it.",
    artifact: <ApprovalText />,
  },
  {
    time: "2:15 pm",
    text: "They approve, and place a $10 hold on their card.",
    artifact: <ApprovalCard />,
  },
  {
    time: "2:15 pm",
    text: "The shop gets a text and an email, and the booking is on the console.",
    artifact: <ShopNotice />,
  },
];

export function WhatHappens() {
  return (
    <section aria-labelledby="story-title" className="border-t border-border">
      <div className={`${shell} flex flex-col gap-10 py-16 sm:py-20`}>
        <SectionHeading id="story-title">What happens</SectionHeading>
        <ol className="flex flex-col">
          {story.map((step, i) => (
            <li
              key={i}
              className="flex flex-col gap-4 border-t border-border py-8 sm:flex-row sm:gap-8"
            >
              <time className="w-20 shrink-0 font-mono text-sm text-muted-foreground">
                {step.time}
              </time>
              <div className="flex flex-1 flex-col gap-5 md:flex-row md:items-start md:justify-between md:gap-10">
                <p className="max-w-xs text-base leading-relaxed">{step.text}</p>
                <div className="md:w-80 md:shrink-0">{step.artifact}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function PlainList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li key={item} className="border-t border-border py-3 leading-relaxed">
          {item}
        </li>
      ))}
    </ul>
  );
}

export function ForTheShop() {
  return (
    <section aria-labelledby="shop-title" className="border-t border-border">
      <div className={`${shell} flex flex-col gap-10 py-16 sm:py-20`}>
        <SectionHeading id="shop-title">For the shop</SectionHeading>
        <div className="grid gap-10 md:grid-cols-2 md:gap-16">
          <div className="flex flex-col gap-4">
            <h3 className="font-serif text-xl">What you do</h3>
            <PlainList
              items={[
                "Set your services, hours and rules once.",
                "Get a text for every booking.",
              ]}
            />
          </div>
          <div className="flex flex-col gap-4">
            <h3 className="font-serif text-xl">What you never do</h3>
            <PlainList
              items={[
                "Answer the phone for it.",
                "Chase no-shows.",
                "Learn a new app.",
              ]}
            />
          </div>
        </div>
        <div className="flex max-w-md flex-col gap-3">
          <p className="text-sm text-muted-foreground">{"Hart's menu, as set today:"}</p>
          <table className="w-full font-mono text-sm">
            <caption className="sr-only">{"Hart's Barbers services"}</caption>
            <tbody>
              {menu.map((item) => (
                <tr key={item.name} className="border-t border-border">
                  <th scope="row" className="py-2 text-left font-normal">
                    {item.name}
                  </th>
                  <td className="py-2 text-muted-foreground">{item.duration}</td>
                  <td className="py-2 text-right">{item.price}</td>
                  <td className="py-2 text-right text-muted-foreground">{item.deposit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function ForAgents() {
  return (
    <section aria-labelledby="agents-title" className="border-t border-border">
      <div className={`${shell} flex flex-col gap-10 py-16 sm:py-20`}>
        <div className="flex flex-col gap-3">
          <SectionHeading id="agents-title">For agents</SectionHeading>
          <p className="max-w-lg leading-relaxed text-muted-foreground">
            For developers and AI companies. Each shop is an MCP server with a
            plain-text guide.
          </p>
        </div>
        <div className="grid gap-10 md:grid-cols-[1fr_1.4fr] md:gap-16">
          <dl className="flex flex-col">
            {agentEndpoints.map((endpoint) => (
              <div key={endpoint.path} className="flex flex-col gap-1 border-t border-border py-3">
                <dt className="text-sm text-muted-foreground">{endpoint.label}</dt>
                <dd className="font-mono text-sm break-all">
                  <a href={endpoint.path} className="underline-offset-4 hover:underline">
                    {endpoint.path}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
          <pre className="overflow-x-auto border-t border-border pt-4 font-mono text-xs leading-relaxed sm:text-sm">
            <code>{bookCall}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className={`${shell} flex flex-col gap-4 py-10 text-sm sm:flex-row sm:items-center sm:justify-between`}>
        <p className="font-serif text-lg">Built in Providence for independent shops.</p>
        <nav aria-label="Footer" className="flex gap-6">
          <Link href={shop.path} className="underline-offset-4 hover:underline">
            {"Hart's Barbers"}
          </Link>
          <a href={contactHref} className="underline-offset-4 hover:underline">
            Email us
          </a>
        </nav>
      </div>
    </footer>
  );
}
