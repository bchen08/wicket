// Shared fixtures for Front Desk tests. Not imported by app code.
import type { Booking, Policies } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import { approveBooking, sendApprovalCode } from "../consent/approvals";
import type { CodeMessage, CodeSender } from "../consent/code-sender";
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

/** The consent settings tests use: localhost links, a fixed pepper, no dev codes. */
export const TEST_CONSENT: ConsentConfig = Object.freeze({
  publicBaseUrl: "http://localhost:3000",
  phonePepper: "test-pepper-0123456789abcdef0123456789abcdef",
  devCodes: false,
});

/** The Origin the approval POSTs must carry with TEST_CONSENT. */
export const TEST_ORIGIN = "http://localhost:3000";

/** A test phone number (E.164) and another one. */
export const PHONE_E164 = "+14015550123";
export const OTHER_PHONE_E164 = "+14015550199";

/** A code sender that remembers every code it was asked to send. */
export function recordingCodeSender(): CodeSender & { sent: CodeMessage[] } {
  const sent: CodeMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push({ ...message });
    },
  };
}

/** `base` with the Ring 1b consent deps (TEST_CONSENT and a recording code sender) unless it has them. */
export function withConsent(
  base: Omit<FrontDeskDeps, "consent" | "codeSender"> & Partial<Pick<FrontDeskDeps, "consent" | "codeSender">>,
): FrontDeskDeps {
  return { consent: TEST_CONSENT, codeSender: recordingCodeSender(), ...base };
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

/** The last code `deps.codeSender` was asked to send (it must be a recordingCodeSender). */
export function lastSentCode(deps: FrontDeskDeps): string {
  const sent = (deps.codeSender as Partial<ReturnType<typeof recordingCodeSender>>).sent;
  const last = sent?.at(-1);
  if (!last) throw new Error("No code was sent (or deps.codeSender doesn't record).");
  return last.code;
}

/**
 * Approve a booking the way the person would, through the approval API's use cases: send a code to
 * `phone`, then approve with it. `booking` must be book's result (it carries the link). Returns the
 * confirmed booking.
 */
export async function approveAsCustomer(deps: FrontDeskDeps, booking: Booking, phone = PHONE_E164): Promise<Booking> {
  const token = approvalToken(booking);
  await sendApprovalCode(deps, token, { phone });
  return (await approveBooking(deps, token, { code: lastSentCode(deps) })).booking;
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
 * policies; `initialBookings` and `initialBlocks` exist before the first call. Consent: TEST_CONSENT
 * (merged with `consent`) and a recording code sender.
 */
export function memoryDeps(
  options: {
    clock?: Clock;
    notifier?: Notifier;
    initialBookings?: InitialBooking[];
    policies?: Partial<Policies>;
    initialBlocks?: NewBlock[];
    consent?: Partial<ConsentConfig>;
    codeSender?: CodeSender;
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
    codeSender: options.codeSender ?? recordingCodeSender(),
  };
}
