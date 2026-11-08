import { requireOwner } from "@/components/console/require-owner";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingDetail } from "@/components/console/booking-detail";

export const metadata: Metadata = {
  title: "Booking detail — Front Desk",
  description: "Review a booking, manage its deposit, and see its history.",
  robots: { index: false, follow: false },
};

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingDetail key={id} id={id} />;
}

export const instant = false;

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  return <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-6 py-12 sm:px-10 sm:py-16">
    <Link href="/console" className="w-fit text-sm underline-offset-4 hover:underline">← All bookings</Link>
    <Suspense fallback={<p role="status">Loading booking…</p>}><Detail params={params} /></Suspense>
  </main>;
}
