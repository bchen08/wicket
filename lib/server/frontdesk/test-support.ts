// Shared fixtures for Front Desk tests. Not imported by app code.
import type { Booking, Policies } from "../../types/frontdesk";
import { fixedClock, type Clock } from "../clock";
import { approveBooking } from "../consent/approvals";
import { newApprovalToken } from "../consent/crypto";
import type { DepositPayments } from "../deposits/payments";
import type { Notifier, OwnerAlert } from "../notify/notifier";
import type { TextProvider, TextSender } from "../notify/text-sender";
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

/** The origin approval links point at in tests (deps.baseUrl). */
export const TEST_BASE_URL = "http://localhost:3000";

/** A test phone number (E.164) and another one. */
export const PHONE_E164 = "+14015550123";
export const OTHER_PHONE_E164 = "+14015550199";

/** `base` with deps.baseUrl = TEST_BASE_URL unless it has one. */
export function withBaseUrl(
  base: Omit<FrontDeskDeps, "baseUrl" | "payments"> & Partial<Pick<FrontDeskDeps, "baseUrl" | "payments">>,
): FrontDeskDeps {
  return { baseUrl: TEST_BASE_URL, payments: null, ...base };
}

/** The consent fields createBooking needs, for tests that call the store directly. */
export function holdFields(approveBy: Date): Pick<NewBooking, "approveBy" | "approvalToken" | "mandate"> {
  return { approveBy, approvalToken: newApprovalToken(), mandate: null };
}

/** The token in a booking's approval link (any booking awaiting approval carries it). */
export function approvalToken(booking: Booking): string {
  const url = booking.approval?.url;
  if (!url) throw new Error(`Booking ${booking.id} has no approval link.`);
  return url.slice(url.lastIndexOf("/") + 1);
}

/**
 * Approve a booking the way the person would, through the approval use case: open the link and
 * approve, giving `phone` (none when null). `booking` must be awaiting approval (it carries the link).
 * Returns the confirmed booking.
 */
export async function approveAsCustomer(deps: FrontDeskDeps, booking: Booking, phone: string | null = PHONE_E164): Promise<Booking> {
  return (await approveBooking(deps, approvalToken(booking), phone === null ? {} : { phone })).booking;
}

/** A Booking.customer as the API returns it. */
export function customerOf(displayName: string, approved: boolean, phone?: string): Booking["customer"] {
  return { displayName, approved, ...(phone ? { phone } : {}) };
}

/** A notifier that remembers what it was told: it routes every alert to the log channel and keeps it here. */
export function recordingNotifier(): Notifier & { alerts: OwnerAlert[] } {
  const alerts: OwnerAlert[] = [];
  return {
    alerts,
    route: () => ({ channel: "log", recipient: null }),
    async send(alert) {
      alerts.push(alert);
    },
  };
}

/** A notifier whose every send fails with `message`, routed like an email to `recipient`. */
export function failingNotifier(message: string, recipient = "dana@example.com"): Notifier {
  return {
    route: () => ({ channel: "email", recipient }),
    async send() {
      throw new Error(message);
    },
  };
}

/** A text sender that sends nothing and remembers every text: [to, body]. A stand-in for Photon or Twilio. */
export function recordingTexter(provider: TextProvider = "twilio"): TextSender & { sent: { to: string; body: string }[] } {
  const sent: { to: string; body: string }[] = [];
  return {
    provider,
    sent,
    async send(to, body) {
      sent.push({ to, body });
    },
  };
}

/** A text sender whose every send fails with `message` (and remembers what it was asked to send). */
export function failingTexter(message: string): TextSender & { tried: { to: string; body: string }[] } {
  const tried: { to: string; body: string }[] = [];
  return {
    provider: "twilio",
    tried,
    async send(to, body) {
      tried.push({ to, body });
      throw new Error(message);
    },
  };
}

/** What a recording notifier was told, as [kind, booking id, booking status] for each alert. */
export function alertSummary(notifier: Notifier): [string, string, string][] {
  return (notifier as ReturnType<typeof recordingNotifier>).alerts.map((a) => [a.kind, a.booking.id, a.booking.status]);
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
 * policies; `initialBookings` and `initialBlocks` exist before the first call. Approval links point at
 * `baseUrl` (default TEST_BASE_URL). Deposits are off unless `payments` is given (see stubPayments in
 * lib/server/deposits/stub-payments.ts). Texting is off unless `texter` is given (see recordingTexter).
 */
export function memoryDeps(
  options: {
    clock?: Clock;
    notifier?: Notifier;
    initialBookings?: InitialBooking[];
    policies?: Partial<Policies>;
    initialBlocks?: NewBlock[];
    baseUrl?: string;
    payments?: DepositPayments | null;
    texter?: TextSender | null;
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
    payments: options.payments ?? null,
    texter: options.texter ?? null,
    baseUrl: options.baseUrl ?? TEST_BASE_URL,
  };
}
