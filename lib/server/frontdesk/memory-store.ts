import type { BlockedTime, BookingStatus, Policies, Service, Shop } from "../../types/frontdesk";
import type { Clock } from "../clock";
import {
  ACTIVE_STATUSES,
  byStart,
  IDEMPOTENCY_TTL_MS,
  SlotTakenError,
  toBooking,
  toBookingEvent,
  type BookingRecord,
  type BookingStore,
  type IdempotencyScope,
  type NewBooking,
  type NewBookingEvent,
} from "./booking-store";
import {
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
import { idempotencyConflict, nestedIdempotencyError, normalizeUuid } from "./idempotency-errors";

// In-memory ShopCatalog + BookingStore, seeded like supabase/seed.sql. Used by the tests and by
// local development when DATABASE_URL is unset. Enforces the same rules as the Postgres schema
// (the no_overlap constraint, foreign keys, the blocked_times checks) and behaves like
// postgres-store.ts in every method. Data lives only as long as the store.

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
    },
  },
};

/**
 * A booking to preload, for tests (e.g. a cancelled one). Preloaded bookings get no events and
 * aren't checked for overlaps.
 */
export type InitialBooking = Omit<NewBooking, "depositCents"> & {
  /** Defaults to "confirmed". */
  status?: BookingStatus;
  /** Defaults to the store clock's now. */
  createdAt?: Date;
  /** The deposit snapshot. Defaults to the service's current deposit. */
  depositCents?: number;
};

export type MemoryStoreOptions = {
  /** Stamps createdAt, event times, lifecycle times and idempotency key ages. Defaults to real time. */
  clock?: Clock;
  /** Bookings that exist before the first call. Not checked for overlaps; no events. */
  initialBookings?: InitialBooking[];
  /** Merged over the seeded Hart's policies. For tests. */
  policies?: Partial<Policies>;
  /** Blocked times that exist before the first call. The staff member must exist. */
  initialBlocks?: NewBlock[];
};

/** The lifecycle times transition() stamps. A Booking doesn't show them; tests read them here. */
export type LifecycleStamps = {
  cancelledAt: Date | null;
  cancelledBy: "agent" | "owner" | null;
  completedAt: Date | null;
  noShowAt: Date | null;
};

/** What createMemoryStore returns: both interfaces plus a read-only hook for tests. */
export type MemoryStore = ShopCatalog &
  BookingStore & {
    /** The lifecycle times stamped on a booking, or null if there's no such booking. For tests. */
    lifecycleStamps(bookingId: string): LifecycleStamps | null;
  };

type StoredBooking = Omit<BookingRecord, "serviceName" | "timezone"> & LifecycleStamps;

type StoredEvent = NewBookingEvent & { seq: number; bookingId: string; at: Date };

type StoredBlock = NewBlock & { id: string };

type SavedKey = { requestHash: string; response: unknown; createdAtMs: number };

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
  if (options.policies) {
    const harts = policies.get("harts");
    if (harts) policies.set("harts", { ...harts, ...defined(options.policies) });
  }

  const bookings: StoredBooking[] = [];
  const events: StoredEvent[] = [];
  const blocks: StoredBlock[] = [];
  const savedKeys = new Map<string, SavedKey>();
  /** Settles when the call running that (tool, key) finishes. Never rejects. */
  const inFlight = new Map<string, Promise<void>>();
  let eventSeq = 0;

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
    const stored: StoredBooking = {
      id: crypto.randomUUID(),
      shopSlug: input.shopSlug,
      serviceId: input.serviceId,
      staffId: input.staffId,
      start: copyDate(input.start),
      end: copyDate(input.end),
      status: input.status ?? "confirmed",
      customerName: input.customerName,
      agentName: input.agentName,
      depositCents: input.depositCents ?? service.depositCents,
      createdAt: input.createdAt ? copyDate(input.createdAt) : at,
      cancelledAt: null,
      cancelledBy: null,
      completedAt: null,
      noShowAt: null,
    };
    bookings.push(stored);
    return stored;
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
      type Tagged = { id: string; kind: "booking" | "block"; staffId: string; start: Date; end: Date };
      const busy: Tagged[] = [
        // Mirrors the no_overlap constraint: awaiting_deposit and confirmed bookings hold time.
        ...bookings
          .filter((b) => b.shopSlug === slug && ACTIVE_STATUSES.includes(b.status) && overlaps(b, range))
          .map((b) => ({ ...b, kind: "booking" as const })),
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
      }));
    },

    async getPolicies(slug) {
      const p = policies.get(slug);
      return p ? { ...p } : null;
    },

    async savePolicies(slug, next) {
      if (!shopOf(slug)) throw new Error(`Unknown shop: ${slug}`); // the policies foreign key
      policies.set(slug, pickPolicies(next));
      return pickPolicies(next);
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
      const list = services.get(slug) ?? [];
      if (list.some((s) => s.id === service.id)) throw new DuplicateServiceError(service.id);
      list.push(pickService(service));
      services.set(slug, list);
      return pickService(service);
    },

    async updateService(slug, id, patch) {
      const service = services.get(slug)?.find((s) => s.id === id);
      if (!service) return null;
      Object.assign(service, pickPatch(patch));
      return { ...service };
    },
  };

  const bookingStore: BookingStore = {
    async createBooking(input) {
      if (!(input.start < input.end)) throw new Error("A booking must end after it starts.");
      // Mirrors: exclude using gist (staff_id with =, during with &&)
      //          where (status in ('awaiting_deposit', 'confirmed'))
      const clash = bookings.some(
        (b) => ACTIVE_STATUSES.includes(b.status) && b.staffId === input.staffId && overlaps(b, input),
      );
      if (clash) throw new SlotTakenError();
      const at = now();
      // Always confirmed and stamped now, like the Postgres insert, whatever extra fields `input` carries.
      const stored = insertBooking({ ...input, status: "confirmed", createdAt: undefined }, at);
      addEvent(stored.id, { actor: "agent", type: "booked", data: { status: "confirmed", agentName: input.agentName } }, at);
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

    async transition(id, expectedStatus, nextStatus, event) {
      // Check and set in one synchronous step (no await in this method), so of two concurrent
      // transitions from the same status exactly one sees expectedStatus.
      const b = findBooking(id);
      if (!b || b.status !== expectedStatus) return null;
      if (nextStatus === "cancelled" && event.actor === "system") {
        // bookings.cancelled_by allows only 'agent' and 'owner'.
        throw new Error('Only an "agent" or "owner" can cancel a booking.');
      }
      const at = now();
      b.status = nextStatus;
      if (nextStatus === "cancelled") {
        b.cancelledAt = at;
        b.cancelledBy = event.actor as "agent" | "owner";
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

    /**
     * See BookingStore.idempotent. Calls with the same (tool, key) run one at a time: each waits on
     * the in-flight promise of the call before it. Key age uses the store clock.
     *
     * Unlike Postgres there is no rollback: if `action` writes and then throws, its writes stay
     * (only the key is not saved). The use cases write only as their last step, so a throwing
     * action has written nothing.
     */
    async idempotent<T>(
      scope: IdempotencyScope,
      action: (store: BookingStore) => Promise<T>,
    ): Promise<{ result: T; replayed: boolean }> {
      // Keys are visible ASCII without spaces, so "<tool> <key>" can't collide.
      const id = `${scope.tool} ${scope.key}`;
      for (let running = inFlight.get(id); running; running = inFlight.get(id)) await running;

      // No await from here to inFlight.set, so no other call can start this key in between.
      const startedAtMs = now().getTime();
      const saved = savedKeys.get(id);
      // Live while at most IDEMPOTENCY_TTL_MS old, like Postgres' `created_at < now() - interval '24 hours'`.
      if (saved && startedAtMs - saved.createdAtMs <= IDEMPOTENCY_TTL_MS) {
        if (saved.requestHash !== scope.requestHash) throw idempotencyConflict(scope.key, scope.tool);
        return { result: jsonCopy(saved.response) as T, replayed: true };
      }

      let release!: () => void;
      inFlight.set(id, new Promise<void>((resolve) => (release = resolve)));
      try {
        const result = await action(actionStore);
        savedKeys.set(id, { requestHash: scope.requestHash, response: jsonCopy(result), createdAtMs: startedAtMs });
        return { result, replayed: false };
      } finally {
        inFlight.delete(id);
        release();
      }
    },
  };

  /** The store an idempotent action gets: the same data, but idempotent() can't nest (as in Postgres). */
  const actionStore: BookingStore = {
    ...bookingStore,
    async idempotent() {
      throw nestedIdempotencyError();
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
  };
}
