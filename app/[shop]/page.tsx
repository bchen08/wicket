import type { Metadata } from "next";
import { BookingContent } from "@/components/public-booking/booking-content";
import {
  agentLinks,
  loadBookingPage,
} from "@/components/public-booking/load-booking-page";

// Block until the form is ready: streamed Suspense replacements need JavaScript.
export const instant = false;

type Props = {
  params: Promise<{ shop: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shop } = await params;
  const data = await loadBookingPage(shop);
  return {
    title: `Book ${data.shop.name} — Front Desk`,
    description: `Choose a service and an available time at ${data.shop.name}. Nothing is booked until you approve.`,
    alternates: {
      types: { "text/markdown": agentLinks(data.bookUrl, shop).instructions },
    },
  };
}

export default async function ShopPage({ params, searchParams }: Props) {
  const { shop } = await params;
  const [data, query] = await Promise.all([
    loadBookingPage(shop),
    searchParams,
  ]);
  return (
    <BookingContent
      data={data}
      slug={shop}
      serviceId={first(query.service)}
      errorCode={first(query.error)}
      message={first(query.message)}
    />
  );
}
