import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import { textingMode } from "@/lib/server/notify/texting";

// /console/unlock: the owner enters the shop's access code (OWNER_API_TOKEN). A plain stand-in (server
// component, an HTML form, no client JS) so the console works in production; v0 restyles it. The form
// posts to /api/owner/session, which sets the fd_owner cookie and answers 303 → /console, or 303 back
// here with ?error=1 on a wrong code.
// Where texting is on (docs/texting.md), a second plain form, "Text me a code", posts to /api/owner/code,
// which texts a 6-digit code to the owner's mobile and comes back here with ?code=sent; the code then posts
// to /api/owner/session as `code` (303 → /console, or back here with ?error=code).

export const instant = false;

export const metadata: Metadata = {
  title: "Unlock bookings — Front Desk",
  robots: { index: false, follow: false },
};

async function WrongCode({
  searchParams,
}: Pick<PageProps<"/console/unlock">, "searchParams">) {
  await connection();
  const { error } = await searchParams;
  if (error !== "1") return null;
  return (
    <p
      role="alert"
      className="border-y border-destructive/40 py-3 text-sm text-destructive"
    >
      That access code didn&apos;t work. Check it and try again.
    </p>
  );
}

/** What the unlock page says about the texted code, by ?code= and ?error=. */
const TEXT_MESSAGES: Record<string, { text: string; alert: boolean }> = {
  sent: { text: "We texted a 6-digit code to the owner's mobile. It works once, for 10 minutes.", alert: false },
  code: { text: "That code didn't work. It may have expired or been used already: text yourself a new one.", alert: true },
  texting_off: { text: "Texting isn't set up here. Use the access code.", alert: true },
  no_mobile: {
    text: "No owner mobile number is set yet. Unlock with the access code, then add the mobile number to the shop's rules.",
    alert: true,
  },
  send_failed: { text: "The text didn't go through. Try again, or use the access code.", alert: true },
};

async function TextMeACode({
  searchParams,
}: Pick<PageProps<"/console/unlock">, "searchParams">) {
  await connection();
  // Only where a text sender is configured; otherwise the page is exactly the access-code form.
  if (textingMode(process.env) === "off") return null;
  const { code, error } = await searchParams;
  const key = code === "sent" ? "sent" : typeof error === "string" ? error : "";
  const message = TEXT_MESSAGES[key];
  const askForCode = key === "sent" || key === "code";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Sign in with a code sent to the owner&apos;s mobile.</p>
      {message ? (
        <p
          role={message.alert ? "alert" : "status"}
          className={
            message.alert
              ? "border-y border-destructive/40 py-3 text-sm text-destructive"
              : "border-y border-border py-3 text-sm"
          }
        >
          {message.text}
        </p>
      ) : null}
      {askForCode ? (
        <form
          method="post"
          action="/api/owner/session"
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-sm">
            Code from the text
            <input
              type="text"
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              className="min-h-12 w-full rounded-md border border-border bg-background px-4 py-3 font-mono text-base"
            />
          </label>
          <button
            type="submit"
            className={buttonVariants({
              size: "lg",
              className: "min-h-12 w-full",
            })}
          >
            Sign in with the code
          </button>
        </form>
      ) : null}
      <form method="post" action="/api/owner/code">
        <button
          type="submit"
          className={buttonVariants({
            variant: askForCode ? "outline" : "default",
            size: "lg",
            className: "min-h-12 w-full",
          })}
        >
          {askForCode ? "Text me a new code" : "Text me a code"}
        </button>
      </form>
    </div>
  );
}

async function AccessCode({ searchParams }: Pick<PageProps<"/console/unlock">, "searchParams">) {
  await connection();
  const texting = textingMode(process.env) !== "off";
  const { error } = await searchParams;
  const form = <div className="flex flex-col gap-4">
    <WrongCode searchParams={searchParams} />
    <form method="post" action="/api/owner/session" className="flex flex-col gap-3">
      <label className="flex flex-col gap-2 text-sm">
        Access code
        <input type="password" name="token" required autoComplete="current-password" className="min-h-12 w-full rounded-md border border-border bg-background px-4 py-3 font-mono text-base" />
      </label>
      <button type="submit" className={buttonVariants({ variant: texting ? "outline" : "default", size: "lg", className: "min-h-12 w-full" })}>Unlock</button>
    </form>
  </div>;
  if (!texting) return <><p className="text-sm text-muted-foreground">Enter the shop&apos;s access code to see its bookings.</p>{form}</>;
  return <details className="border-t border-border pt-4" open={error === "1" || error === "no_mobile" || error === "send_failed"}>
    <summary className="mb-4 cursor-pointer rounded-sm py-2 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Use the access code instead</summary>
    {form}
  </details>;
}

export default function UnlockPage({
  searchParams,
}: PageProps<"/console/unlock">) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-8 px-6 py-8 sm:px-10 sm:py-12">
      <Link
        href="/"
        className="w-fit font-serif text-xl"
      >
        Front Desk<span>.</span>
      </Link>
      <section className="mt-6 flex flex-col gap-5 border-t border-border pt-8 sm:mt-12">
        <p className="text-sm text-muted-foreground">For the shop owner</p>
        <h1 className="font-serif text-4xl leading-tight sm:text-5xl">Welcome back.</h1>
        <Suspense fallback={null}>
          <TextMeACode searchParams={searchParams} />
          <AccessCode searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  );
}
