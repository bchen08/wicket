import { requireOwner } from "@/components/console/require-owner";
import { headers } from "next/headers";
import type { ApiError, BookingsResponse } from "@/lib/types/frontdesk";
import { BookingGroup } from "@/components/owner-booking-card";
import { RefreshBookings } from "@/components/refresh-bookings";

async function loadBookings(): Promise<BookingsResponse> {
  await requireOwner();
  const incoming = await headers();
  const host = incoming.get("host");
  if (!host) throw new Error("Unable to determine the booking API address.");
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
    ? "http"
    : "https";
  const response = await fetch(
    `${protocol}://${host}/api/shops/harts/bookings`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { cookie: incoming.get("cookie") ?? "" },
    },
  );
  if (!response.ok) {
    const body: Partial<ApiError> | null = await response
      .json()
      .catch(() => null);
    throw Object.assign(
      new Error(
        body?.error?.message || `Unable to load bookings (${response.status}).`,
      ),
      {
        nextAction: body?.error?.next_action,
      },
    );
  }
  return response.json() as Promise<BookingsResponse>;
}

export async function OwnerBookings() {
  await requireOwner();
  let data: BookingsResponse;
  try {
    data = await loadBookings();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load bookings.";
    const nextAction =
      error instanceof Error &&
      "nextAction" in error &&
      typeof error.nextAction === "string"
        ? error.nextAction
        : null;
    return (
      <section className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-serif text-4xl leading-tight sm:text-5xl">Bookings</h1>
          <RefreshBookings />
        </div>
        <div
          role="alert"
          className="flex flex-col gap-2 border-t border-border pt-5 wrap-anywhere"
        >
          <h2 className="font-serif text-xl">Could not load bookings</h2>
          <p className="text-sm">{message}</p>
          {nextAction && (
            <p className="text-sm text-muted-foreground">{nextAction}</p>
          )}
        </div>
      </section>
    );
  }
  // This server component reads the clock after an uncached request, never during prerendering.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const upcoming = data.bookings.filter(
    (booking) => Date.parse(booking.start) >= now,
  );
  const past = data.bookings.filter(
    (booking) => Date.parse(booking.start) < now,
  );
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-3 wrap-anywhere">
          <p className="text-sm text-muted-foreground">
            Bookings
          </p>
          <h1 className="font-serif text-4xl leading-tight text-balance sm:text-5xl">
            {data.shop.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            Times in <span className="font-mono">{data.shop.timezone}</span>
          </p>
        </div>
        <RefreshBookings />
      </header>
      {data.bookings.length === 0 ? (
        <p className="border-t border-border pt-6 text-base leading-relaxed text-muted-foreground">
          No bookings yet. When an AI agent books Hart&apos;s, it shows up here.
        </p>
      ) : (
        <>
          <BookingGroup title="Upcoming" bookings={upcoming} now={now} />
          <BookingGroup title="Past" bookings={past} now={now} />
        </>
      )}
    </div>
  );
}
