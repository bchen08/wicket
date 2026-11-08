import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { DateTime } from "luxon";
import type { ApprovalView, Mandate } from "@/lib/types/frontdesk";
import { getApprovalView } from "@/lib/server/consent/approvals";
import { formatDisplay } from "@/lib/server/engine/availability";
import { getFrontDeskDeps } from "@/lib/server/frontdesk/deps";
import { FrontDeskError } from "@/lib/server/frontdesk/errors";

// The approval link the agent sends the person: /approve/<token>. A plain stand-in (server component,
// HTML forms, no client JS) so links work in production; v0 restyles it. The forms post to
// /api/approvals/<token>/approve and /decline, which answer 303 back here with the new status.

export const metadata: Metadata = {
  title: "Approve your booking — Front Desk",
  robots: { index: false, follow: false },
};

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** An RFC 3339 instant in the shop's zone, e.g. "Tue 10 Nov, 10:10 am EST". */
const inShopZone = (rfc3339: string, timezone: string) => formatDisplay(DateTime.fromISO(rfc3339).setZone(timezone));

/** What the form posts' ?error=<code> means, when the person can fix it here. */
const FORM_ERRORS: Record<string, string> = {
  invalid_request: "That phone number doesn't look right. Enter it with the country code, e.g. +1 401 555 0123, or leave it empty.",
  internal: "Something went wrong on our side. Please try again.",
};

function mandateLines(mandate: Mandate, timezone: string): string[] {
  const lines: string[] = [];
  if (mandate.priceCapCents !== undefined) lines.push(`Price up to ${usd(mandate.priceCapCents)}`);
  if (mandate.depositCapCents !== undefined) lines.push(`Deposit up to ${usd(mandate.depositCapCents)}`);
  if (mandate.window) {
    lines.push(`Between ${inShopZone(mandate.window.from, timezone)} and ${inShopZone(mandate.window.to, timezone)}`);
  }
  return lines;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border py-3 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-40">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

function Details({ view }: { view: ApprovalView }) {
  const rules = [view.policies.depositRule, view.policies.lateCancelRule, view.policies.noShowRule].filter(
    (rule) => rule.trim() !== "",
  );
  const mandate = view.mandate ? mandateLines(view.mandate, view.shop.timezone) : [];
  return (
    <dl className="flex flex-col">
      <Row label="Shop">{view.shop.name}</Row>
      <Row label="Service">{view.serviceName}</Row>
      <Row label="Time">{view.display}</Row>
      <Row label="Price">{usd(view.priceCents)}</Row>
      <Row label="Deposit">{view.depositCents > 0 ? `${usd(view.depositCents)} (not charged yet)` : "None"}</Row>
      <Row label="Cancellation">
        <p>Cancel at least {view.policies.cancelWindowHours} hours before the start to keep any deposit.</p>
        {rules.map((rule) => (
          <p key={rule} className="mt-1 text-sm text-muted-foreground">
            {rule}
          </p>
        ))}
      </Row>
      <Row label="Booked by">{view.agentName}</Row>
      <Row label="Name">{view.customerName}</Row>
      {mandate.length > 0 && (
        <Row label="Your limits">
          {mandate.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Row>
      )}
    </dl>
  );
}

function Answer({ token, view, error }: { token: string; view: ApprovalView; error: string | null }) {
  const action = (verb: "approve" | "decline") => `/api/approvals/${encodeURIComponent(token)}/${verb}`;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Hold expires at {inShopZone(view.expiresAt, view.shop.timezone)}.
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <form method="post" action={action("approve")} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Phone number (optional, for the shop)
          <input
            type="tel"
            name="phone"
            autoComplete="tel"
            placeholder="+1 401 555 0123"
            className="rounded-lg border border-border bg-card px-3 py-2 text-base"
          />
        </label>
        <button type="submit" className="rounded-lg bg-primary px-4 py-3 font-medium text-primary-foreground">
          Approve
        </button>
      </form>
      <form method="post" action={action("decline")}>
        <button type="submit" className="w-full rounded-lg border border-border px-4 py-3 font-medium">
          Decline
        </button>
      </form>
    </div>
  );
}

const CLOSED: Record<Exclude<ApprovalView["status"], "pending">, { title: string; body: string }> = {
  approved: { title: "You're booked", body: "The shop has your booking. Your agent can see it's confirmed." },
  declined: { title: "You declined this booking", body: "The time is free again. Ask your agent if you want another one." },
  expired: {
    title: "This booking request has expired",
    body: "It wasn't approved in time, or it was cancelled. Ask your agent to book again if you still want it.",
  },
};

async function Approval({ params, searchParams }: PageProps<"/approve/[token]">) {
  await connection();
  const { token } = await params;
  const query = await searchParams;
  let view: ApprovalView;
  try {
    view = await getApprovalView(getFrontDeskDeps(), token);
  } catch (err) {
    if (err instanceof FrontDeskError && err.code === "booking_not_found") {
      return (
        <section className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium">This link isn&apos;t valid</h1>
          <p className="text-muted-foreground">Check that the whole link was copied. If it still doesn&apos;t work, ask your agent to book again.</p>
        </section>
      );
    }
    console.error("[approve page] could not load the approval", err);
    return (
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">We couldn&apos;t load this booking</h1>
        <p className="text-muted-foreground">Please try again in a minute.</p>
      </section>
    );
  }

  const code = typeof query.error === "string" ? query.error : null;
  const closed = view.status === "pending" ? null : CLOSED[view.status];
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">{closed ? closed.title : "Approve your booking"}</h1>
        <p className="text-muted-foreground">
          {closed ? closed.body : `${view.agentName} asked ${view.shop.name} to book this for you. Nothing is booked until you approve.`}
        </p>
      </header>
      <Details view={view} />
      {view.status === "pending" && <Answer token={token} view={view} error={code ? (FORM_ERRORS[code] ?? null) : null} />}
    </section>
  );
}

export default function ApprovePage(props: PageProps<"/approve/[token]">) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
      <p className="text-sm font-medium text-primary">Front Desk</p>
      <Suspense fallback={<p role="status" className="text-muted-foreground">Loading your booking…</p>}>
        <Approval {...props} />
      </Suspense>
    </main>
  );
}
