import { headers } from "next/headers";
import type { ApiError, BookingsResponse } from "@/lib/types/frontdesk";
import { BookingGroup } from "@/components/owner-booking-card";
import { RefreshBookings } from "@/components/refresh-bookings";

async function loadBookings(): Promise<BookingsResponse> {
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
          <h1 className="text-2xl font-medium">Bookings</h1>
          <RefreshBookings />
        </div>
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5 wrap-anywhere"
        >
          <h2 className="font-medium">Could not load bookings</h2>
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
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 wrap-anywhere">
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-primary">
            Bookings
          </p>
          <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
            {data.shop.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Times in {data.shop.timezone}
          </p>
        </div>
        <RefreshBookings />
      </header>
      {data.bookings.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm leading-7 text-muted-foreground">
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
