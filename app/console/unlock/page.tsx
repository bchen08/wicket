import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

// /console/unlock: the owner enters the shop's access code (OWNER_API_TOKEN). A plain stand-in (server
// component, an HTML form, no client JS) so the console works in production; v0 restyles it. The form
// posts to /api/owner/session, which sets the fd_owner cookie and answers 303 → /console, or 303 back
// here with ?error=1 on a wrong code.

export const metadata: Metadata = {
  title: "Unlock bookings — Front Desk",
  robots: { index: false, follow: false },
};

async function WrongCode({ searchParams }: Pick<PageProps<"/console/unlock">, "searchParams">) {
  await connection();
  const { error } = await searchParams;
  if (error !== "1") return null;
  return (
    <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
      That access code didn&apos;t work. Check it and try again.
    </p>
  );
}

export default function UnlockPage({ searchParams }: PageProps<"/console/unlock">) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/" className="w-fit text-sm font-medium text-primary">
        ← Front Desk
      </Link>
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-medium">Unlock bookings</h1>
        <p className="text-muted-foreground">Enter the shop&apos;s access code to see its bookings.</p>
        <Suspense fallback={null}>
          <WrongCode searchParams={searchParams} />
        </Suspense>
        <form method="post" action="/api/owner/session" className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Access code
            <input
              type="password"
              name="token"
              required
              autoComplete="current-password"
              className="rounded-lg border border-border bg-card px-3 py-2 text-base"
            />
          </label>
          <button type="submit" className="rounded-lg bg-primary px-4 py-3 font-medium text-primary-foreground">
            Unlock
          </button>
        </form>
      </section>
    </main>
  );
}
