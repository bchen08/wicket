import type { BlockedTime, BookingStatus, DepositState, Mandate, Policies, Service, Shop } from "../../types/frontdesk";
import type { Clock } from "../clock";
import {
  ACTIVE_STATUSES,
  byStart,
  expiredEventData,
  normalizeUuid,
  SlotTakenError,
  toAlert,
  toBooking,
  toBookingEvent,
  type BookingRecord,
  type BookingStore,
  type DepositFailure,
  type DepositPatch,
  type NewAlert,
  type NewBooking,
  type NewBookingEvent,
} from "./booking-store";
import {
  DepositExceedsPriceError,
  DuplicateServiceError,
  toBlockedTime,
  type BusyInterval,
  type NewBlock,
  type ServicePatch,
  type ShopCatalog,
  type StaffHours,
  type TimeRange,
  type WeeklyHours,
} from "./catalog";
import { DEFAULT_POLICIES } from "./policies";

// In-memory ShopCatalog + BookingStore, seeded like supabase/seed.sql. Used by the tests and by
// local development when DATABASE_URL is unset. Enforces the same rules as the Postgres schema
// (the no_overlap constraint, foreign keys, the blocked_times checks, deposit <= price) and behaves
// like postgres-store.ts in every method. Data lives only as long as the store.

type StaffSeed = { id: string; shopSlug: string; name: string; weekly: WeeklyHours[] };

const OPEN_DAYS = [2, 3, 4, 5, 6] as const; // Tue–Sat (ISO weekdays)

/** Keep in step with supabase/seed.sql. Each store works on its own deep copy; never mutate this. */
export const SEED: {
  shops: Shop[];
  services: Record<string, Service[]>;
  staff: StaffSeed[];
  /** Keyed by shop slug. */
  policies: Record<string, Policies>;
} = {
  shops: [{ slug: "harts", name: "Hart's Barbers", timezone: "America/New_York" }],
  services: {
    harts: [
      { id: "haircut", name: "Haircut", durationMin: 30, priceCents: 3500, depositCents: 1000 },
      { id: "beard-trim", name: "Beard trim", durationMin: 15, priceCents: 1500, depositCents: 0 },
      { id: "haircut-beard", name: "Haircut + beard trim", durationMin: 45, priceCents: 4500, depositCents: 1000 },
    ],
  },
  staff: [
    {
      id: "dana",
      shopSlug: "harts",
      name: "Dana",
      // Lunch 12:00–12:30 is the gap between the two windows.
      weekly: OPEN_DAYS.flatMap((weekday) => [
        { weekday, open: "09:00", close: "12:00" },
        { weekday, open: "12:30", close: "17:00" },
      ]),
    },
  ],
  policies: {
    // Book at least 2 hours ahead, up to 30 days ahead (6 for services with a deposit); cancel at
    // least 24 hours ahead to keep the deposit.
    harts: {
      leadTimeMin: 120,
      horizonDays: 30,
      depositHorizonDays: 6,
      cancelWindowHours: 24,
      paused: false,
      phone: "+1 212-555-0142",
      depositRule:
        "Services with a deposit need it when you book. We hold the deposit on your card at booking; it is only charged if you miss the appointment or cancel late.",
      lateCancelRule:
        "Cancel at least 24 hours before your appointment and the deposit is released. Cancel within 24 hours and we keep the deposit as a late-cancellation fee.",
      noShowRule: "If you don't show up, we keep the deposit. Otherwise it is released after your appointment.",
      // Not seeded: the owner sets it (PUT /api/shops/harts/policies). Until then alerts are logged.
      ownerEmail: null,
    },
  },
};

/**
 * A booking to preload, for tests (e.g. a cancelled one). Preloaded bookings get no events and
 * aren't checked for overlaps.
 */
export type InitialBooking = Omit<NewBooking, "depositCents" | "approveBy" | "approvalToken" | "mandate"> & {
  /** Defaults to "confirmed". */
  status?: BookingStatus;
  /** Defaults to the store clock's now. */
  createdAt?: Date;
  /** The deposit snapshot. Defaults to the service's current deposit. */
  depositCents?: number;
  /** When the hold lapses. Required for status awaiting_approval. */
  approveBy?: Date;
  /** With it, the booking gets an undecided approval request with this token. */
  approvalToken?: string;
  mandate?: Mandate | null;
  /** The deposit columns (0005). Defaults: state "none", the rest null. awaiting_deposit needs payBy. */
  depositState?: DepositState;
  checkoutSessionId?: string;
  checkoutUrl?: string;
  paymentIntentId?: string;
  payBy?: Date;
};

export type MemoryStoreOptions = {
  /** Stamps createdAt, event times and lifecycle times. Defaults to real time. */
  clock?: Clock;
  /** Bookings that exist before the first call. Not checked for overlaps; no events. */
  initialBookings?: InitialBooking[];
  /** Merged over the seeded Hart's policies. null: Hart's has no policies row. For tests. */
  policies?: Partial<Policies> | null;
  /** Blocked times that exist before the first call. The staff member must exist. */
  initialBlocks?: NewBlock[];
};

/** The lifecycle times transition() stamps. A Booking doesn't show them; tests read them here. */
export type LifecycleStamps = {
  cancelledAt: Date | null;
  cancelledBy: "agent" | "owner" | "customer" | null;
  completedAt: Date | null;
  noShowAt: Date | null;
};

/** A stored approval request (the approvals table). */
export type StoredApproval = {
  bookingId: string;
  token: string;
  createdAt: Date;
  decidedAt: Date | null;
  decision: "approved" | "declined" | null;
};

/** Copies of the consent rows, for tests. */
export type ConsentRows = {
  approvals: StoredApproval[];
  /** Each booking's consent columns: approve_by, customer_phone, mandate. */
  bookings: { id: string; approveBy: Date | null; customerPhone: string | null; mandate: Mandate | null }[];
};

/** What createMemoryStore returns: both interfaces plus read-only hooks for tests. */
export type MemoryStore = ShopCatalog &
  BookingStore & {
    /** The lifecycle times stamped on a booking, or null if there's no such booking. For tests. */
    lifecycleStamps(bookingId: string): LifecycleStamps | null;
    /** Copies of the consent rows. For tests. */
    consentRows(): ConsentRows;
  };

type StoredBooking = Omit<
  BookingRecord,
  "serviceName" | "timezone" | "customerApproved" | "customerPhone" | "approvalToken" | "approveBy"
> &
  LifecycleStamps & {
    approveBy: Date | null;
    customerPhone: string | null;
    mandate: Mandate | null;
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
  };

type StoredEvent = NewBookingEvent & { seq: number; bookingId: string; at: Date };

type StoredBlock = NewBlock & { id: string };

type StoredAlert = NewAlert & { seq: number; createdAt: Date };

/** Longest blocked_times.reason (the column's check constraint). */
const MAX_BLOCK_REASON = 200;

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A deep copy through JSON, like a value stored in and read back from a jsonb column. */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const copyDate = (d: Date) => new Date(d.getTime());

const DEPOSIT_STATES: readonly DepositState[] = ["none", "awaiting_payment", "held", "captured", "released", "not_collected"];

/** Write a DepositPatch's fields onto a stored booking (absent fields keep their values). Checks the state first. */
function applyDepositPatch(b: StoredBooking, patch: DepositPatch | undefined): void {
  if (!patch) return;
  if (patch.state !== undefined) b.depositState = patch.state;
  if (patch.checkoutSessionId !== undefined) b.checkoutSessionId = patch.checkoutSessionId;
  if (patch.checkoutUrl !== undefined) b.checkoutUrl = patch.checkoutUrl;
  if (patch.paymentIntentId !== undefined) b.paymentIntentId = patch.paymentIntentId;
  if (patch.payBy !== undefined) b.payBy = copyDate(patch.payBy);
}

/** The bookings_deposit_state_check and bookings_deposit_has_deadline checks, for a row about to be written. */
function checkDepositRow(status: BookingStatus, state: DepositState, payBy: Date | null | undefined): void {
  if (!DEPOSIT_STATES.includes(state)) throw new Error(`deposit_state must be one of ${DEPOSIT_STATES.join(", ")}.`);
  if (status === "awaiting_deposit" && !payBy) throw new Error("A booking awaiting its deposit needs pay_by.");
}

const copyFailure = (f: DepositFailure): DepositFailure => ({ action: f.action, message: f.message, at: copyDate(f.at) });

/** `patch` without its undefined fields, so spreading it never overwrites a value with undefined. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Exactly the Policies fields (a caller's object may carry extras, which Postgres would never store). */
function pickPolicies(p: Policies): Policies {
  return {
    leadTimeMin: p.leadTimeMin,
    horizonDays: p.horizonDays,
    depositHorizonDays: p.depositHorizonDays,
    cancelWindowHours: p.cancelWindowHours,
    paused: p.paused,
    phone: p.phone,
    depositRule: p.depositRule,
    lateCancelRule: p.lateCancelRule,
    noShowRule: p.noShowRule,
    ownerEmail: p.ownerEmail,
  };
}

/** Exactly the Service fields. */
function pickService(s: Service): Service {
  return { id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents, depositCents: s.depositCents };
}

/** Exactly the fields an owner may patch, without undefined ones. */
function pickPatch(patch: ServicePatch): ServicePatch {
  const { name, durationMin, priceCents, depositCents } = patch;
  return defined({ name, durationMin, priceCents, depositCents });
}

function sortWeek(weekly: WeeklyHours[]): WeeklyHours[] {
  return weekly.map((w) => ({ ...w })).sort((a, b) => a.weekday - b.weekday || compareText(a.open, b.open));
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const now = () => options.clock?.now() ?? new Date();

  // Each store owns a deep copy of the seed, so owner writes in one store (one test) never reach another.
  const shops: Shop[] = structuredClone(SEED.shops);
  const services = new Map(Object.entries(structuredClone(SEED.services)));
  const staff: StaffSeed[] = structuredClone(SEED.staff);
  const policies = new Map(Object.entries(structuredClone(SEED.policies)));
  if (options.policies === null) {
    policies.delete("harts");
  } else if (options.policies) {
    const harts = policies.get("harts");
    if (harts) policies.set("harts", { ...harts, ...defined(options.policies) });
  }

  const bookings: StoredBooking[] = [];
  const events: StoredEvent[] = [];
  const blocks: StoredBlock[] = [];
  const alerts: StoredAlert[] = [];
  let eventSeq = 0;
  let alertSeq = 0;
  // Ring 1b approval requests, keyed by booking id.
  const approvals = new Map<string, StoredApproval>();

  const shopOf = (slug: string) => shops.find((s) => s.slug === slug);
  const staffInShop = (slug: string, staffId: string) => staff.find((s) => s.id === staffId && s.shopSlug === slug);
  const zoneOfStaff = (staffId: string) => {
    const member = staff.find((s) => s.id === staffId);
    const shop = member && shopOf(member.shopSlug);
    if (!shop) throw new Error(`Unknown staff member: ${staffId}`);
    return shop.timezone;
  };
  const findBooking = (id: string) => {
    const key = normalizeUuid(id);
    return key === null ? undefined : bookings.find((b) => b.id === key);
  };

  /** The booking joined with its shop and service, like the Postgres store's select. */
  function record(b: StoredBooking): BookingRecord {
    const shop = shopOf(b.shopSlug);
    const service = services.get(b.shopSlug)?.find((s) => s.id === b.serviceId);
    if (!shop || !service) throw new Error(`Unknown shop or service: ${b.shopSlug}/${b.serviceId}`);
    return {
      id: b.id,
      shopSlug: b.shopSlug,
      serviceId: b.serviceId,
      serviceName: service.name,
      depositCents: b.depositCents,
      staffId: b.staffId,
      start: copyDate(b.start),
      end: copyDate(b.end),
      status: b.status,
      customerName: b.customerName,
      agentName: b.agentName,
      createdAt: copyDate(b.createdAt),
      // Like the Postgres left join on approvals.
      customerApproved: approvals.get(b.id)?.decision === "approved",
      customerPhone: b.customerPhone,
      approvalToken: approvals.get(b.id)?.token ?? null,
      approveBy: b.approveBy && copyDate(b.approveBy),
      depositState: b.depositState,
      checkoutUrl: b.checkoutUrl,
      payBy: b.payBy && copyDate(b.payBy),
      depositFailure: b.depositFailure && copyFailure(b.depositFailure),
      timezone: shop.timezone,
    };
  }

  function insertBooking(input: InitialBooking, at: Date): StoredBooking {
    // Same foreign keys as Postgres: the shop, service and staff member must exist.
    const service = services.get(input.shopSlug)?.find((s) => s.id === input.serviceId);
    if (!shopOf(input.shopSlug) || !service) {
      throw new Error(`Unknown shop or service: ${input.shopSlug}/${input.serviceId}`);
    }
    if (!staff.some((s) => s.id === input.staffId)) throw new Error(`Unknown staff member: ${input.staffId}`);
    const status = input.status ?? "confirmed";
    // The bookings_hold_has_deadline check, and approvals.token unique.
    if (status === "awaiting_approval" && !input.approveBy) throw new Error("A booking awaiting approval needs approveBy.");
    checkDepositRow(status, input.depositState ?? "none", input.payBy);
    if (input.approvalToken && [...approvals.values()].some((a) => a.token === input.approvalToken)) {
      throw new Error("approvals.token must be unique.");
    }
    const stored: StoredBooking = {
      id: crypto.randomUUID(),
      shopSlug: input.shopSlug,
      serviceId: input.serviceId,
      staffId: input.staffId,
      start: copyDate(input.start),
      end: copyDate(input.end),
      status,
      customerName: input.customerName,
      agentName: input.agentName,
      depositCents: input.depositCents ?? service.depositCents,
      createdAt: input.createdAt ? copyDate(input.createdAt) : at,
      cancelledAt: null,
      cancelledBy: null,
      completedAt: null,
      noShowAt: null,
      approveBy: input.approveBy ? copyDate(input.approveBy) : null,
      customerPhone: null,
      mandate: input.mandate ? jsonCopy(input.mandate) : null,
      depositState: input.depositState ?? "none",
      checkoutSessionId: input.checkoutSessionId ?? null,
      checkoutUrl: input.checkoutUrl ?? null,
      paymentIntentId: input.paymentIntentId ?? null,
      payBy: input.payBy ? copyDate(input.payBy) : null,
      depositFailure: null,
    };
    bookings.push(stored);
    if (input.approvalToken) {
      approvals.set(stored.id, { bookingId: stored.id, token: input.approvalToken, createdAt: at, decidedAt: null, decision: null });
    }
    return stored;
  }

  /** Expire one lapsed hold (decide()'s expire row), with its "expired" event. True if it expired. */
  function expireIfLapsed(b: StoredBooking, at: Date): boolean {
    if (b.status !== "awaiting_approval" || !b.approveBy || b.approveBy.getTime() > at.getTime()) return false;
    b.status = "expired";
    addEvent(b.id, { actor: "system", type: "expired", data: expiredEventData(b.depositCents) }, now());
    return true;
  }

  function addEvent(bookingId: string, event: NewBookingEvent, at: Date): void {
    events.push({ seq: ++eventSeq, bookingId, at, actor: event.actor, type: event.type, data: jsonCopy(event.data) });
  }

  function insertBlock(block: NewBlock): StoredBlock {
    // Mirrors the blocked_times checks: a non-empty half-open range and a short reason.
    if (!(block.start < block.end)) throw new Error("A blocked time must end after it starts.");
    if (block.reason.length > MAX_BLOCK_REASON) {
      throw new Error(`A blocked time's reason is at most ${MAX_BLOCK_REASON} characters.`);
    }
    const stored: StoredBlock = {
      id: crypto.randomUUID(),
      staffId: block.staffId,
      start: copyDate(block.start),
      end: copyDate(block.end),
      reason: block.reason,
    };
    blocks.push(stored);
    return stored;
  }

  const blockedTime = (b: StoredBlock): BlockedTime => toBlockedTime(b, zoneOfStaff(b.staffId));

  for (const b of options.initialBookings ?? []) insertBooking(b, now());
  for (const b of options.initialBlocks ?? []) {
    if (!staff.some((s) => s.id === b.staffId)) throw new Error(`Unknown staff member: ${b.staffId}`);
    insertBlock(b);
  }

  const catalog: ShopCatalog = {
    async getShop(slug) {
      const shop = shopOf(slug);
      return shop ? { ...shop } : null;
    },

    async listServices(slug) {
      return (services.get(slug) ?? []).map((s) => ({ ...s }));
    },

    async getStaffHours(slug): Promise<StaffHours[]> {
      return staff
        .filter((s) => s.shopSlug === slug)
        .sort((a, b) => compareText(a.id, b.id))
        .map((s) => ({ staffId: s.id, staffName: s.name, weekly: sortWeek(s.weekly) }));
    },

    async getBusyIntervals(slug, range): Promise<BusyInterval[]> {
      type Tagged = { id: string; kind: "booking" | "block"; staffId: string; start: Date; end: Date; heldUntil?: Date };
      const busy: Tagged[] = [
        // Mirrors the no_overlap constraint: awaiting_approval, awaiting_deposit and confirmed bookings
        // hold time. A hold carries its deadline, approve_by or pay_by (lapsed ones included, like Postgres).
        ...bookings
          .filter((b) => b.shopSlug === slug && ACTIVE_STATUSES.includes(b.status) && overlaps(b, range))
          .map((b) => ({
            id: b.id,
            staffId: b.staffId,
            start: b.start,
            end: b.end,
            kind: "booking" as const,
            ...(b.status === "awaiting_approval" && b.approveBy ? { heldUntil: b.approveBy } : {}),
            ...(b.status === "awaiting_deposit" && b.payBy ? { heldUntil: b.payBy } : {}),
          })),
        ...blocks
          .filter((b) => staffInShop(slug, b.staffId) && overlaps(b, range))
          .map((b) => ({ ...b, kind: "block" as const })),
      ];
      // Same order as the Postgres store: start, then kind, then id.
      busy.sort((a, b) => a.start.getTime() - b.start.getTime() || compareText(a.kind, b.kind) || compareText(a.id, b.id));
      return busy.map((b) => ({
        staffId: b.staffId,
        start: copyDate(b.start),
        end: copyDate(b.end),
        kind: b.kind,
        reason: `${b.kind} ${b.id}`,
        ...(b.heldUntil ? { heldUntil: copyDate(b.heldUntil) } : {}),
      }));
    },

    async getPolicies(slug) {
      const p = policies.get(slug);
      return p ? { ...p } : null;
    },

    async savePolicies(slug, patch) {
      if (!shopOf(slug)) throw new Error(`Unknown shop: ${slug}`); // the policies foreign key
      // Read, merge and write in one synchronous step (no await in this method), so concurrent calls
      // with different fields both take effect. A shop without a row starts from the defaults.
      const merged = pickPolicies({ ...(policies.get(slug) ?? DEFAULT_POLICIES), ...defined(patch) });
      policies.set(slug, merged);
      return { ...merged };
    },

    async replaceWeeklyHours(slug, staffId, weekly) {
      const member = staffInShop(slug, staffId);
      if (!member) return false;
      member.weekly = sortWeek(weekly);
      return true;
    },

    async listBlocks(slug, range) {
      return blocks
        .filter((b) => staffInShop(slug, b.staffId) && overlaps(b, range))
        .sort(byStart)
        .map(blockedTime);
    },

    async createBlock(slug, block) {
      if (!staffInShop(slug, block.staffId)) return null;
      return blockedTime(insertBlock(block));
    },

    async deleteBlock(slug, id) {
      const key = normalizeUuid(id);
      const index = blocks.findIndex((b) => b.id === key && staffInShop(slug, b.staffId));
      if (index < 0) return null;
      const [removed] = blocks.splice(index, 1);
      return blockedTime(removed);
    },

    async createService(slug, service) {
      if (!shopOf(slug)) throw new Error(`Unknown shop: ${slug}`); // the services foreign key
      // The services_deposit_le_price check, which Postgres runs before the primary key.
      if (service.depositCents > service.priceCents) throw new DepositExceedsPriceError(service.id);
      const list = services.get(slug) ?? [];
      if (list.some((s) => s.id === service.id)) throw new DuplicateServiceError(service.id);
      list.push(pickService(service));
      services.set(slug, list);
      return pickService(service);
    },

    async updateService(slug, id, patch) {
      // Check and set in one synchronous step (no await in this method), so the deposit check judges
      // the row as it is now, including a concurrent update's result.
      const service = services.get(slug)?.find((s) => s.id === id);
      if (!service) return null;
      const next = { ...service, ...pickPatch(patch) };
      // The services_deposit_le_price check: refuse without changing anything.
      if (next.depositCents > next.priceCents) throw new DepositExceedsPriceError(id);
      Object.assign(service, next);
      return { ...service };
    },
  };

  const bookingStore: BookingStore = {
    async createBooking(input) {
      if (!(input.start < input.end)) throw new Error("A booking must end after it starts.");
      // Mirrors: exclude using gist (staff_id with =, during with &&)
      //          where (status in ('awaiting_approval', 'awaiting_deposit', 'confirmed'))
      // A lapsed hold that nobody expired still clashes, as in Postgres: book expires them first.
      const clash = bookings.some(
        (b) => ACTIVE_STATUSES.includes(b.status) && b.staffId === input.staffId && overlaps(b, input),
      );
      if (clash) throw new SlotTakenError();
      const at = now();
      // Always awaiting approval and stamped now, like the Postgres insert, whatever extra fields `input` carries.
      const stored = insertBooking({ ...input, status: "awaiting_approval", createdAt: undefined }, at);
      addEvent(
        stored.id,
        {
          actor: "agent",
          type: "booked",
          data: {
            status: "awaiting_approval",
            agentName: input.agentName,
            ...(stored.mandate ? { mandate: stored.mandate } : {}),
          },
        },
        at,
      );
      return toBooking(record(stored));
    },

    async listBookings(shopSlug, range) {
      return bookings
        .filter((b) => b.shopSlug === shopSlug && overlaps(b, range))
        .sort(byStart)
        .map((b) => toBooking(record(b)));
    },

    async getBooking(id) {
      const b = findBooking(id);
      return b ? toBooking(record(b)) : null;
    },

    async refreshBooking(id, at) {
      // One synchronous step, like Postgres' single statement.
      const b = findBooking(id);
      if (!b) return null;
      expireIfLapsed(b, at);
      return toBooking(record(b));
    },

    async expireStaleHolds(shopSlug, range, at) {
      let expired = 0;
      for (const b of bookings) {
        if (b.shopSlug === shopSlug && overlaps(b, range) && expireIfLapsed(b, at)) expired++;
      }
      return expired;
    },

    async transition(id, expectedStatus, nextStatus, event, deposit) {
      // Check and set in one synchronous step (no await in this method), so of two concurrent
      // transitions from the same status exactly one sees expectedStatus.
      const b = findBooking(id);
      if (!b || b.status !== expectedStatus) return null;
      if (nextStatus === "cancelled" && event.actor === "system") {
        // bookings.cancelled_by allows only 'agent', 'owner' and 'customer'.
        throw new Error('Only an "agent", "owner" or "customer" can cancel a booking.');
      }
      checkDepositRow(nextStatus, deposit?.state ?? b.depositState, deposit?.payBy ?? b.payBy);
      const at = now();
      b.status = nextStatus;
      applyDepositPatch(b, deposit);
      if (nextStatus === "cancelled") {
        b.cancelledAt = at;
        b.cancelledBy = event.actor as "agent" | "owner" | "customer";
      } else if (nextStatus === "completed") {
        b.completedAt = at;
      } else if (nextStatus === "no_show") {
        b.noShowAt = at;
      }
      addEvent(b.id, event, at);
      return toBooking(record(b));
    },

    async listEvents(bookingId) {
      const b = findBooking(bookingId);
      if (!b) return [];
      const timezone = record(b).timezone;
      return events
        .filter((e) => e.bookingId === b.id)
        .sort((x, y) => x.at.getTime() - y.at.getTime() || x.seq - y.seq)
        .map((e) =>
          toBookingEvent({
            id: String(e.seq),
            bookingId: e.bookingId,
            at: e.at,
            actor: e.actor,
            type: e.type,
            data: jsonCopy(e.data),
            timezone,
          }),
        );
    },

    // ---- Ring 1b: consent. Each method checks and writes in one synchronous step (no await), so it
    // is atomic like its Postgres transaction, and it checks everything before writing anything. ----

    async findApproval(token) {
      const approval = [...approvals.values()].find((a) => a.token === token);
      const b = approval && bookings.find((x) => x.id === approval.bookingId);
      if (!approval || !b?.approveBy) return null;
      return {
        bookingId: b.id,
        decision: approval.decision,
        approveBy: copyDate(b.approveBy),
        mandate: b.mandate && jsonCopy(b.mandate),
      };
    },

    async answerApproval(input) {
      const b = findBooking(input.bookingId);
      const approval = b && approvals.get(b.id);
      // Check everything first: there is no rollback here.
      if (!b || !approval || approval.decision !== null) return { ok: false, reason: "not_pending" };
      if (b.status !== "awaiting_approval" || !b.approveBy || b.approveBy.getTime() <= input.now.getTime()) {
        return { ok: false, reason: "not_pending" };
      }
      if (input.nextStatus === "cancelled" && input.event.actor === "system") {
        throw new Error('Only an "agent", "owner" or "customer" can cancel a booking.');
      }
      // The bookings.customer_phone check.
      if (input.phone && !/^\+[1-9][0-9]{7,14}$/.test(input.phone)) throw new Error("customer_phone must be E.164.");
      const deposit = input.decision === "approved" ? input.deposit : undefined;
      checkDepositRow(input.nextStatus, deposit?.state ?? b.depositState, deposit?.payBy ?? b.payBy);
      const at = now();
      if (input.decision === "approved" && input.phone) b.customerPhone = input.phone;
      b.status = input.nextStatus;
      applyDepositPatch(b, deposit);
      if (input.nextStatus === "cancelled") {
        b.cancelledAt = at;
        b.cancelledBy = "customer";
      }
      addEvent(b.id, input.event, at);
      approval.decision = input.decision;
      approval.decidedAt = copyDate(input.now);
      return { ok: true, booking: toBooking(record(b)) };
    },

    // ---- Ring 1c: deposits ----

    async getDeposit(id) {
      const b = findBooking(id);
      if (!b) return null;
      return {
        state: b.depositState,
        checkoutSessionId: b.checkoutSessionId,
        paymentIntentId: b.paymentIntentId,
        payBy: b.payBy && copyDate(b.payBy),
      };
    },

    async updateDeposit(id, outcome, event) {
      // One synchronous step, like Postgres' single statement.
      const b = findBooking(id);
      if (!b) return null;
      if (outcome.state !== undefined) checkDepositRow(b.status, outcome.state, b.payBy);
      if (outcome.state !== undefined) b.depositState = outcome.state;
      if (outcome.failure !== undefined) b.depositFailure = outcome.failure && copyFailure(outcome.failure);
      if (event) addEvent(b.id, event, now());
      return toBooking(record(b));
    },

    // ---- Owner alerts ----

    async recordAlert(alert) {
      // The alerts table's foreign keys and checks.
      const shop = shopOf(alert.shopSlug);
      if (!shop) throw new Error(`Unknown shop: ${alert.shopSlug}`);
      if (!findBooking(alert.bookingId)) throw new Error(`Unknown booking: ${alert.bookingId}`);
      if (alert.recipient !== null && alert.recipient.length > 254) throw new Error("recipient is too long.");
      const stored: StoredAlert = { ...alert, bookingId: alert.bookingId.toLowerCase(), seq: ++alertSeq, createdAt: now() };
      alerts.push(stored);
      return toAlert({ ...stored, id: String(stored.seq), createdAt: copyDate(stored.createdAt), timezone: shop.timezone });
    },

    async listAlerts(shopSlug, limit) {
      const shop = shopOf(shopSlug);
      if (!shop) return [];
      return alerts
        .filter((a) => a.shopSlug === shopSlug)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq)
        .slice(0, limit)
        .map((a) => toAlert({ ...a, id: String(a.seq), createdAt: copyDate(a.createdAt), timezone: shop.timezone }));
    },
  };

  return {
    ...catalog,
    ...bookingStore,
    lifecycleStamps(bookingId) {
      const b = findBooking(bookingId);
      if (!b) return null;
      return {
        cancelledAt: b.cancelledAt && copyDate(b.cancelledAt),
        cancelledBy: b.cancelledBy,
        completedAt: b.completedAt && copyDate(b.completedAt),
        noShowAt: b.noShowAt && copyDate(b.noShowAt),
      };
    },
    consentRows() {
      return {
        approvals: [...approvals.values()].map((a) => ({
          ...a,
          createdAt: copyDate(a.createdAt),
          decidedAt: a.decidedAt && copyDate(a.decidedAt),
        })),
        bookings: bookings.map((b) => ({
          id: b.id,
          approveBy: b.approveBy && copyDate(b.approveBy),
          customerPhone: b.customerPhone,
          mandate: b.mandate && jsonCopy(b.mandate),
        })),
      };
    },
  };
}
