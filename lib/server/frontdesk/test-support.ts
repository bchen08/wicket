// Shared fixtures for Front Desk tests. Not imported by app code.
import type { Booking, Policies } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import { approveBooking } from "../consent/approvals";
import type { ConsentConfig } from "../consent/config";
import { newApprovalToken, sha256Hex } from "../consent/crypto";
import type { Notifier } from "../notify/notifier";
import type { NewBooking } from "./booking-store";
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

/** The consent settings tests use: localhost links. */
export const TEST_CONSENT: ConsentConfig = Object.freeze({ publicBaseUrl: "http://localhost:3000" });

/** A test phone number (E.164) and another one. */
export const PHONE_E164 = "+14015550123";
export const OTHER_PHONE_E164 = "+14015550199";

/** `base` with the Ring 1b consent deps (TEST_CONSENT) unless it has them. */
export function withConsent(base: Omit<FrontDeskDeps, "consent"> & Partial<Pick<FrontDeskDeps, "consent">>): FrontDeskDeps {
  return { consent: TEST_CONSENT, ...base };
}

/** The consent fields createBooking needs, for tests that call the store directly. */
export function holdFields(approveBy: Date): Pick<NewBooking, "approveBy" | "approvalTokenHash" | "mandate"> {
  return { approveBy, approvalTokenHash: sha256Hex(newApprovalToken()), mandate: null };
}

/** The token in a booking's approval link (book's result only). */
export function approvalToken(booking: Booking): string {
  const url = booking.approval?.url;
  if (!url) throw new Error(`Booking ${booking.id} has no approval link.`);
  return url.slice(url.lastIndexOf("/") + 1);
}

/**
 * Approve a booking the way the person would, through the approval use case: open the link and
 * approve, giving `phone` (none when null). `booking` must be book's result (it carries the link).
 * Returns the confirmed booking.
 */
export async function approveAsCustomer(deps: FrontDeskDeps, booking: Booking, phone: string | null = PHONE_E164): Promise<Booking> {
  return (await approveBooking(deps, approvalToken(booking), phone === null ? {} : { phone })).booking;
}

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
 * `deps` with some catalog methods replaced where use cases read deps.catalog. `overrides` gets the
 * catalog it replaces methods on; close over shared state (e.g. a counter) outside it.
 */
export function withCatalog(
  deps: FrontDeskDeps,
  overrides: (catalog: ShopCatalog) => Partial<ShopCatalog>,
): FrontDeskDeps {
  return {
    ...deps,
    catalog: { ...deps.catalog, ...overrides(deps.catalog) },
  };
}

/**
 * Deps backed by a fresh in-memory store and a fixed clock. `policies` is merged over Hart's seeded
 * policies; `initialBookings` and `initialBlocks` exist before the first call. Consent: TEST_CONSENT
 * (merged with `consent`).
 */
export function memoryDeps(
  options: {
    clock?: Clock;
    notifier?: Notifier;
    initialBookings?: InitialBooking[];
    policies?: Partial<Policies>;
    initialBlocks?: NewBlock[];
    consent?: Partial<ConsentConfig>;
  } = {},
): FrontDeskDeps {
  const clock = options.clock ?? fixedClock(NOW);
  const store = createMemoryStore({
    clock,
    initialBookings: options.initialBookings,
    policies: options.policies,
    initialBlocks: options.initialBlocks,
  });
  return {
    clock,
    catalog: store,
    store,
    notifier: options.notifier ?? recordingNotifier(),
    consent: { ...TEST_CONSENT, ...options.consent },
  };
}
