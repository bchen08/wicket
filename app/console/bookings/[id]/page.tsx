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

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
    <Link href="/console" className="w-fit text-sm font-medium text-primary">← All bookings</Link>
    <Suspense fallback={<p role="status">Loading booking…</p>}><Detail params={params} /></Suspense>
  </main>;
}
