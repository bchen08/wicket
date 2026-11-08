import { requireOwner } from "@/components/console/require-owner";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { OwnerBookings } from "@/components/owner-bookings";

export const metadata: Metadata = {
  title: "Bookings — Front Desk",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function ConsolePage() {
  await requireOwner();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-6 py-12 sm:px-10 sm:py-16">
      <Link href="/" className="w-fit text-sm underline-offset-4 hover:underline">
        ← Front Desk
      </Link>
      <Suspense
        fallback={
          <p role="status" className="text-muted-foreground">
            Loading bookings…
          </p>
        }
      >
        <OwnerBookings />
      </Suspense>
    </main>
  );
}
