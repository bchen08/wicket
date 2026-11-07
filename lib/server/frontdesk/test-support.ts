// Shared fixtures for Front Desk tests. Not imported by app code.
import type { Booking, Policies } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import type { Notifier } from "../notify/notifier";
import type { NewBlock, ShopCatalog } from "./catalog";
import { createMemoryStore, type InitialBooking } from "./memory-store";
import type { FrontDeskDeps } from "./service";

/**
 * "Now" in most tests: Monday 9 Nov 2026, noon in New York (Hart's is closed on Mondays). The coming
 * Saturday is 14 Nov, 5 days ahead: inside both the 30-day horizon and the 6-day deposit horizon.
 */
export const NOW = new Date("2026-11-09T12:00:00-05:00");

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

/**
 * `deps` with some catalog methods replaced, both where use cases read deps.catalog and inside
 * idempotent actions (book, cancel), which read the catalog through the store they're given.
 * `overrides` gets the catalog it replaces methods on; close over shared state (e.g. a counter)
 * outside it.
 */
export function withCatalog(
  deps: FrontDeskDeps,
  overrides: (catalog: ShopCatalog) => Partial<ShopCatalog>,
): FrontDeskDeps {
  return {
    ...deps,
    catalog: { ...deps.catalog, ...overrides(deps.catalog) },
    store: {
      ...deps.store,
      idempotent: (scope, action) => deps.store.idempotent(scope, (tx) => action({ ...tx, ...overrides(tx) })),
    },
  };
}

/**
 * Deps backed by a fresh in-memory store and a fixed clock. `policies` is merged over Hart's seeded
 * policies; `initialBookings` and `initialBlocks` exist before the first call.
 */
export function memoryDeps(
  options: {
    clock?: Clock;
    notifier?: Notifier;
    initialBookings?: InitialBooking[];
    policies?: Partial<Policies>;
    initialBlocks?: NewBlock[];
  } = {},
): FrontDeskDeps {
  const clock = options.clock ?? fixedClock(NOW);
  const store = createMemoryStore({
    clock,
    initialBookings: options.initialBookings,
    policies: options.policies,
    initialBlocks: options.initialBlocks,
  });
  return { clock, catalog: store, store, notifier: options.notifier ?? recordingNotifier() };
}
