import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { BookingPageResponse } from "@/lib/types/web-booking";

export const loadBookingPage = cache(
  async (shop: string): Promise<BookingPageResponse> => {
    const incoming = await headers();
    const host = incoming.get("host");
    if (!host) throw new Error("Unable to determine the booking API address.");
    const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
      ? "http"
      : "https";
    const response = await fetch(
      `${protocol}://${host}/api/shops/${encodeURIComponent(shop)}/booking-page`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: { cookie: incoming.get("cookie") ?? "" },
      },
    );
    if (response.status === 404) notFound();
    if (!response.ok)
      throw new Error(`Unable to load booking times (${response.status}).`);
    return response.json() as Promise<BookingPageResponse>;
  },
);

export function agentLinks(bookUrl: string, shop: string) {
  const origin = new URL(bookUrl).origin;
  return {
    mcp: `${origin}/api/mcp`,
    instructions: `${origin}/api/shops/${encodeURIComponent(shop)}/agents.md`,
  };
}
