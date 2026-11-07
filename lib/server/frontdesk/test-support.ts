// Shared fixtures for Front Desk tests. Not imported by app code.
import type { Booking } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import type { Notifier } from "../notify/notifier";
import { createMemoryStore, type InitialBooking } from "./memory-store";
import type { FrontDeskDeps } from "./service";

/** "Now" in most tests: Saturday 7 Nov 2026, noon in New York. The coming Saturday is 14 Nov. */
export const NOW = new Date("2026-11-07T12:00:00-05:00");

/** The whole of Saturday 14 Nov in New York. */
export const SAT = { from: "2026-11-14T00:00:00-05:00", to: "2026-11-15T00:00:00-05:00" };

const at = (hhmm: string) => new Date(`2026-11-14T${hhmm}:00-05:00`);

/** The two example bookings slice 1 hard-coded on Sat 14 Nov: 10:00–10:45 and 15:00–15:30, with dana. */
export const EXAMPLE_BOOKINGS: InitialBooking[] = [
  {
    shopSlug: "harts",
    serviceId: "haircut-beard",
    staffId: "dana",
    start: at("10:00"),
    end: at("10:45"),
    customerName: "Sam Example",
    agentName: "test agent",
  },
  {
    shopSlug: "harts",
    serviceId: "haircut",
    staffId: "dana",
    start: at("15:00"),
    end: at("15:30"),
    customerName: "Lee Example",
    agentName: "test agent",
  },
];

/** A notifier that remembers what it was told. */
export function recordingNotifier(): Notifier & { alerts: Booking[] } {
  const alerts: Booking[] = [];
  return {
    alerts,
    async alertOwner(booking) {
      alerts.push(booking);
    },
  };
}

/** Deps backed by a fresh in-memory store and a fixed clock. */
export function memoryDeps(
  options: { clock?: Clock; notifier?: Notifier; initialBookings?: InitialBooking[] } = {},
): FrontDeskDeps {
  const clock = options.clock ?? fixedClock(NOW);
  const store = createMemoryStore({ clock, initialBookings: options.initialBookings });
  return { clock, catalog: store, store, notifier: options.notifier ?? recordingNotifier() };
}
