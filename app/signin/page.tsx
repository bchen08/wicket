import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import type { SigninFormError, SigninView } from "@/lib/types/oauth";
import { getSigninView } from "@/lib/server/oauth/authorize";
import { getSigninDeps } from "@/lib/server/oauth/deps";

// /signin — where a person connecting Front Desk to Claude or ChatGPT signs in, so their agent books as them.
// The OAuth authorization endpoint (/api/oauth/authorize) sends them here with the request's parameters.
// A plain stand-in (server component, an HTML form, no client JS) so sign-in works in production; v0 restyles
// it. The form posts to /api/oauth/authorize, which answers 303 back to the agent (or here with ?error=…).
// TODO(ring-2): verify the number with a texted code once texting lands.

export const metadata: Metadata = {
  title: "Sign in — Front Desk",
  robots: { index: false, follow: false },
};

const FORM_ERRORS: Record<SigninFormError, string> = {
  invalid_name: "Enter your name (up to 80 characters).",
  invalid_phone: "That number doesn't look right. Enter your mobile number, e.g. 401 555 0123 or +44 7700 900123.",
  internal: "Something went wrong on our side. Please try again.",
};

const inputClass = "min-h-12 w-full rounded-lg border border-border bg-background px-4 py-3 text-base";

function Ask({ view }: { view: Extract<SigninView, { kind: "ask" }> }) {
  const hidden = Object.entries(view.params).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <p className="eyebrow text-primary">Sign in to {view.shop.name}</p>
        <h1 className="section-title">{view.clientName} wants to book for you</h1>
        <p className="text-muted-foreground">
          {view.clientName} ({view.clientHost}) is asking to book appointments at {view.shop.name} as you, and to see and
          cancel your bookings there. Sign in with your name and mobile number so you don&apos;t have to type them again.
          You still approve every booking yourself.
        </p>
      </header>
      {view.error && (
        <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
          {FORM_ERRORS[view.error]}
        </p>
      )}
      <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-3">
        {hidden}
        <label className="flex flex-col gap-1 text-sm">
          Your name, as the shop should see it
          <input type="text" name="name" required maxLength={80} autoComplete="name" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Mobile number
          <input type="tel" name="phone" required autoComplete="tel" placeholder="401 555 0123" className={inputClass} />
        </label>
        <button
          type="submit"
          name="decision"
          value="allow"
          className={buttonVariants({ size: "lg", className: "min-h-12 w-full" })}
        >
          Allow
        </button>
      </form>
      <form method="post" action="/api/oauth/authorize">
        {hidden}
        <button
          type="submit"
          name="decision"
          value="deny"
          className={buttonVariants({ variant: "outline", size: "lg", className: "min-h-12 w-full" })}
        >
          Deny
        </button>
      </form>
    </section>
  );
}

async function Signin({ searchParams }: PageProps<"/signin">) {
  await connection();
  const query = await searchParams;
  const get = (name: string) => {
    const value = query[name];
    return typeof value === "string" ? value : null;
  };
  let view: SigninView;
  try {
    // The issuer only matters for redirects, which this page doesn't make.
    view = await getSigninView(getSigninDeps(""), get);
  } catch (err) {
    console.error("[signin page] could not load the sign-in request", err);
    view = { kind: "error", message: "Please go back to your assistant and try connecting again in a minute." };
  }
  if (view.kind === "error") {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface/50 p-6 sm:p-8">
        <h1 className="text-2xl font-medium">We can&apos;t sign you in</h1>
        <p className="text-muted-foreground wrap-anywhere">{view.message}</p>
      </section>
    );
  }
  return <Ask view={view} />;
}

export default function SigninPage(props: PageProps<"/signin">) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-10 px-5 py-8 leading-relaxed sm:px-8 sm:py-12">
      <Link href="/" className="w-fit text-lg font-semibold tracking-tight text-primary">
        Front Desk<span className="text-foreground">.</span>
      </Link>
      <Suspense
        fallback={
          <p role="status" className="text-muted-foreground">
            Loading…
          </p>
        }
      >
        <Signin {...props} />
      </Suspense>
    </main>
  );
}
