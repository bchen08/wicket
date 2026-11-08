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
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/" className="w-fit text-sm font-medium text-primary">
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
