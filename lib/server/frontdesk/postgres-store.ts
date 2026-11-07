import postgres from "postgres";
import type { BlockedTime, Booking, BookingActor, BookingEventType, BookingStatus, Policies, Service } from "../../types/frontdesk";
import {
  IDEMPOTENCY_TTL_MS,
  SlotTakenError,
  toBooking,
  toBookingEvent,
  type BookingRecord,
  type BookingStore,
  type IdempotencyScope,
  type IdempotentStore,
  type NewBooking,
} from "./booking-store";
import {
  DuplicateServiceError,
  toBlockedTime,
  type BusyInterval,
  type ShopCatalog,
  type StaffHours,
  type TimeRange,
  type WeeklyHours,
} from "./catalog";
import { idempotencyConflict, nestedIdempotencyError, normalizeUuid } from "./idempotency-errors";

// Postgres ShopCatalog + BookingStore (postgres.js), for the schema in
// supabase/migrations/0001_skeleton.sql and 0002_rules.sql.

/** SQLSTATE exclusion_violation: the bookings.no_overlap constraint fired. */
const EXCLUSION_VIOLATION = "23P01";
/** SQLSTATE unique_violation: e.g. a services primary key clash. */
const UNIQUE_VIOLATION = "23505";
/** SQLSTATE deadlock_detected. See createBooking. */
const DEADLOCK_DETECTED = "40P01";
/** Tries per createBooking when inserts deadlock. */
const MAX_INSERT_ATTEMPTS = 3;

// One client per connection string, kept at module scope so a warm serverless instance reuses
// its connections instead of opening new ones on every request. In practice there is one.
const clients = new Map<string, postgres.Sql>();

/** The shared postgres.js client for `url`, created on first use. Connects lazily, on the first query. */
export function getPostgresClient(url: string): postgres.Sql {
  let sql = clients.get(url);
  if (!sql) {
    sql = postgres(url, {
      // DATABASE_URL is Supabase's transaction pooler (port 6543), which hands each transaction
      // to whichever server connection is free, so named prepared statements would break.
      prepare: false,
      // Close idle connections so a frozen serverless instance doesn't hold pooler slots.
      idle_timeout: 20,
      connect_timeout: 10,
    });
    clients.set(url, sql);
  }
  return sql;
}

/** Close every client. For tests and scripts; the app never calls this. */
export async function closePostgresClients(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map((sql) => sql.end({ timeout: 5 })));
}

/**
 * Where a store's queries run: the root client, or one transaction (the store an idempotent action
 * gets). postgres.js' TransactionSql doesn't extend Sql, so `sql` is their union; both are callable
 * the same way. Only the root can begin a transaction; only a transaction has savepoints.
 */
type Conn = { kind: "root"; sql: postgres.Sql } | { kind: "tx"; sql: postgres.TransactionSql };
type Db = Conn["sql"];

type BookingRow = {
  id: string;
  shop_slug: string;
  service_id: string;
  service_name: string;
  deposit_cents: number;
  staff_id: string;
  start_at: Date;
  end_at: Date;
  status: BookingStatus;
  customer_name: string;
  agent_name: string;
  created_at: Date;
  timezone: string;
};

function toRecord(r: BookingRow): BookingRecord {
  return {
    id: r.id,
    shopSlug: r.shop_slug,
    serviceId: r.service_id,
    serviceName: r.service_name,
    depositCents: r.deposit_cents,
    staffId: r.staff_id,
    start: r.start_at,
    end: r.end_at,
    status: r.status,
    customerName: r.customer_name,
    agentName: r.agent_name,
    createdAt: r.created_at,
    timezone: r.timezone,
  };
}

type EventRow = {
  id: string;
  booking_id: string;
  at: Date;
  actor: BookingActor;
  type: BookingEventType;
  data: Record<string, unknown>;
  timezone: string;
};

type BlockRow = { id: string; staff_id: string; start_at: Date; end_at: Date; reason: string; timezone: string };

function toBlock(r: BlockRow): BlockedTime {
  return toBlockedTime({ id: r.id, staffId: r.staff_id, start: r.start_at, end: r.end_at, reason: r.reason }, r.timezone);
}

type ServiceRow = { id: string; name: string; duration_min: number; price_cents: number; deposit_cents: number };

function toService(r: ServiceRow): Service {
  return {
    id: r.id,
    name: r.name,
    durationMin: r.duration_min,
    priceCents: r.price_cents,
    depositCents: r.deposit_cents,
  };
}

type PoliciesRow = {
  lead_time_min: number;
  horizon_days: number;
  deposit_horizon_days: number;
  cancel_window_hours: number;
  paused: boolean;
  phone: string | null;
  deposit_rule: string;
  late_cancel_rule: string;
  no_show_rule: string;
};

function toPolicies(r: PoliciesRow): Policies {
  return {
    leadTimeMin: r.lead_time_min,
    horizonDays: r.horizon_days,
    depositHorizonDays: r.deposit_horizon_days,
    cancelWindowHours: r.cancel_window_hours,
    paused: r.paused,
    phone: r.phone,
    depositRule: r.deposit_rule,
    lateCancelRule: r.late_cancel_rule,
    noShowRule: r.no_show_rule,
  };
}

// Query fragments. Built fresh for each query, on the connection that runs it.

/** A half-open tstzrange literal for `range`. */
const tstzrange = (db: Db, range: TimeRange) =>
  db`tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')`;

/**
 * The columns of a Booking. `b` is bookings or a CTE with the same columns; depositCents is the
 * booking's own snapshot, and the service name is joined in by bookingJoins.
 */
const bookingColumns = (db: Db) => db`
  b.id::text as id, b.shop_slug, b.service_id, sv.name as service_name, b.deposit_cents,
  b.staff_id, lower(b.during) as start_at, upper(b.during) as end_at, b.status,
  b.customer_name, b.agent_name, b.created_at, sh.timezone
`;
const bookingJoins = (db: Db) => db`
  join services sv on sv.shop_slug = b.shop_slug and sv.id = b.service_id
  join shops sh on sh.slug = b.shop_slug
`;

const policyColumns = (db: Db) => db`
  lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone,
  deposit_rule, late_cancel_rule, no_show_rule
`;

/**
 * One statement: insert the booking with its deposit snapshot and its "booked" event (data-modifying
 * CTEs), and return the joined Booking.
 */
async function insertBooking(db: Db, input: NewBooking): Promise<Booking> {
  const rows = await db<BookingRow[]>`
    with b as (
      insert into bookings (shop_slug, service_id, staff_id, during, status, customer_name, agent_name, deposit_cents)
      values (
        ${input.shopSlug}, ${input.serviceId}, ${input.staffId}, ${tstzrange(db, input)},
        'confirmed', ${input.customerName}, ${input.agentName}, ${input.depositCents}
      )
      returning *
    ), e as (
      insert into events (booking_id, actor, type, data)
      select id, 'agent', 'booked', jsonb_build_object('status', status, 'agentName', agent_name) from b
    )
    select ${bookingColumns(db)} from b ${bookingJoins(db)}
  `;
  if (!rows[0]) throw new Error("Insert into bookings returned no row.");
  return toBooking(toRecord(rows[0]));
}

/** The BookingStore methods over `conn`: the root client, or the transaction an idempotent action runs in. */
function bookingStoreOn(conn: Conn): BookingStore {
  const db: Db = conn.sql;

  const store: BookingStore = {
    async createBooking(input) {
      // Two overlapping inserts that arrive together can deadlock: an exclusion constraint is
      // checked after the row is inserted, so each insert waits to see whether the other commits.
      // Postgres aborts one with 40P01 (after deadlock_timeout, 1 s by default). Retrying it sees the
      // winner's committed row and fails cleanly with 23P01. If it still deadlocks after
      // MAX_INSERT_ATTEMPTS, other overlapping inserts are winning, so the slot is taken.
      // Inside a transaction each attempt runs in a savepoint, so a failed attempt rolls back only
      // itself instead of aborting the whole transaction.
      for (let attempt = 1; ; attempt++) {
        try {
          return conn.kind === "tx"
            ? await conn.sql.savepoint((sp) => insertBooking(sp, input))
            : await insertBooking(conn.sql, input);
        } catch (err) {
          if (!(err instanceof postgres.PostgresError)) throw err;
          if (err.code === EXCLUSION_VIOLATION) throw new SlotTakenError();
          if (err.code === DEADLOCK_DETECTED) {
            if (attempt < MAX_INSERT_ATTEMPTS) continue;
            throw new SlotTakenError();
          }
          throw err;
        }
      }
    },

    async listBookings(shopSlug, range) {
      const rows = await db<BookingRow[]>`
        select ${bookingColumns(db)}
        from bookings b ${bookingJoins(db)}
        where b.shop_slug = ${shopSlug} and b.during && ${tstzrange(db, range)}
        order by lower(b.during), b.id
      `;
      return rows.map((r) => toBooking(toRecord(r)));
    },

    async getBooking(id) {
      const key = normalizeUuid(id);
      if (key === null) return null; // Postgres would raise 22P02 on a malformed uuid
      const rows = await db<BookingRow[]>`
        select ${bookingColumns(db)} from bookings b ${bookingJoins(db)} where b.id = ${key}::uuid
      `;
      return rows[0] ? toBooking(toRecord(rows[0])) : null;
    },

    async transition(id, expectedStatus, nextStatus, event) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      // One statement, so the update and its event commit together. Of two concurrent transitions
      // the second waits for the first's row lock, re-checks `status = expectedStatus` against the
      // committed row, matches nothing, and so writes no event and returns no row.
      const rows = await db<BookingRow[]>`
        with t as (
          update bookings set
            status = ${nextStatus},
            cancelled_at = case when ${nextStatus === "cancelled"} then now() else cancelled_at end,
            cancelled_by = case when ${nextStatus === "cancelled"} then ${event.actor} else cancelled_by end,
            completed_at = case when ${nextStatus === "completed"} then now() else completed_at end,
            no_show_at = case when ${nextStatus === "no_show"} then now() else no_show_at end
          where id = ${key}::uuid and status = ${expectedStatus}
          returning *
        ), e as (
          insert into events (booking_id, actor, type, data)
          select id, ${event.actor}::text, ${event.type}::text, ${db.json(event.data as postgres.JSONValue)}::jsonb from t
        )
        select ${bookingColumns(db)} from t b ${bookingJoins(db)}
      `;
      return rows[0] ? toBooking(toRecord(rows[0])) : null;
    },

    async listEvents(bookingId) {
      const key = normalizeUuid(bookingId);
      if (key === null) return [];
      const rows = await db<EventRow[]>`
        select e.id::text as id, e.booking_id::text as booking_id, e.at, e.actor, e.type, e.data, sh.timezone
        from events e
        join bookings b on b.id = e.booking_id
        join shops sh on sh.slug = b.shop_slug
        where e.booking_id = ${key}::uuid
        order by e.at, e.id
      `;
      return rows.map((r) =>
        toBookingEvent({
          id: r.id,
          bookingId: r.booking_id,
          at: r.at,
          actor: r.actor,
          type: r.type,
          data: r.data,
          timezone: r.timezone,
        }),
      );
    },

    async idempotent<T>(
      scope: IdempotencyScope,
      action: (store: IdempotentStore) => Promise<T>,
    ): Promise<{ result: T; replayed: boolean }> {
      if (conn.kind === "tx") throw nestedIdempotencyError();
      const outcome = await conn.sql.begin(async (tx) => {
        // Claim the key: a new key inserts; one older than the TTL is taken over. If another
        // transaction holds the key uncommitted, this waits for it to commit or roll back first.
        const claimed = await tx`
          insert into idempotency_keys (key, tool, request_hash)
          values (${scope.key}, ${scope.tool}, ${scope.requestHash})
          on conflict (key, tool) do update
            set request_hash = excluded.request_hash, response = null, created_at = now()
            where idempotency_keys.created_at < now() - ${IDEMPOTENCY_TTL_MS}::double precision * interval '1 millisecond'
          returning key
        `;
        if (claimed.length > 0) {
          // A throw here rolls back the whole transaction: the action's writes and the key. The
          // action reads through the same transaction too (see IdempotentStore).
          const txConn: Conn = { kind: "tx", sql: tx };
          const result = await action({ ...catalogOn(txConn), ...bookingStoreOn(txConn) });
          await tx`
            update idempotency_keys set response = ${tx.json(result as postgres.JSONValue)}::jsonb
            where key = ${scope.key} and tool = ${scope.tool}
          `;
          return { result, replayed: false };
        }
        // The key is live and committed (the insert above already waited for any transaction
        // holding it), so its response is visible to this statement.
        const [saved] = await tx<{ request_hash: string; response: T; pending: boolean }[]>`
          select request_hash, response, response is null as pending
          from idempotency_keys where key = ${scope.key} and tool = ${scope.tool}
        `;
        if (!saved || saved.pending) {
          throw new Error(`Idempotency key ${scope.tool}/${scope.key} has no saved response.`);
        }
        if (saved.request_hash !== scope.requestHash) throw idempotencyConflict(scope.key, scope.tool);
        return { result: saved.response, replayed: true };
      });
      return outcome as { result: T; replayed: boolean };
    },
  };
  return store;
}

/**
 * The ShopCatalog methods over `conn`: the root client, or the transaction an idempotent action runs
 * in (so its reads use the connection that transaction already holds).
 */
function catalogOn(conn: Conn): ShopCatalog {
  const sql: Db = conn.sql;
  return {
    async getShop(slug) {
      const rows = await sql<{ slug: string; name: string; timezone: string }[]>`
        select slug, name, timezone from shops where slug = ${slug}
      `;
      return rows[0] ? { slug: rows[0].slug, name: rows[0].name, timezone: rows[0].timezone } : null;
    },

    async listServices(slug) {
      const rows = await sql<ServiceRow[]>`
        select id, name, duration_min, price_cents, deposit_cents
        from services where shop_slug = ${slug}
        order by position, id
      `;
      return rows.map(toService);
    },

    async getStaffHours(slug) {
      const rows = await sql<
        { staff_id: string; staff_name: string; weekday: number | null; opens: string | null; closes: string | null }[]
      >`
        select s.id as staff_id, s.name as staff_name, w.weekday,
               to_char(w.opens, 'HH24:MI') as opens, to_char(w.closes, 'HH24:MI') as closes
        from staff s
        left join weekly_hours w on w.staff_id = s.id
        where s.shop_slug = ${slug}
        order by s.id, w.weekday, w.opens
      `;
      const byStaff = new Map<string, StaffHours>();
      for (const r of rows) {
        let staff = byStaff.get(r.staff_id);
        if (!staff) {
          staff = { staffId: r.staff_id, staffName: r.staff_name, weekly: [] };
          byStaff.set(r.staff_id, staff);
        }
        if (r.weekday !== null && r.opens !== null && r.closes !== null) {
          staff.weekly.push({ weekday: r.weekday as WeeklyHours["weekday"], open: r.opens, close: r.closes });
        }
      }
      return [...byStaff.values()];
    },

    async getBusyIntervals(slug, range): Promise<BusyInterval[]> {
      // Weekly hours already leave out lunch, so busy time is bookings that hold time (the statuses
      // in the no_overlap constraint) plus blocked times. Ordered by start, then kind, then id.
      const rows = await sql<
        { kind: "booking" | "block"; id: string; staff_id: string; start_at: Date; end_at: Date }[]
      >`
        select busy.kind, busy.id::text as id, busy.staff_id, busy.start_at, busy.end_at
        from (
          select 'booking' as kind, b.id, b.staff_id, lower(b.during) as start_at, upper(b.during) as end_at
          from bookings b
          where b.shop_slug = ${slug}
            and b.status in ('awaiting_deposit', 'confirmed')
            and b.during && ${tstzrange(sql, range)}
          union all
          select 'block', bt.id, bt.staff_id, lower(bt.during), upper(bt.during)
          from blocked_times bt
          join staff s on s.id = bt.staff_id
          where s.shop_slug = ${slug} and bt.during && ${tstzrange(sql, range)}
        ) busy
        order by busy.start_at, busy.kind, busy.id
      `;
      return rows.map((r) => ({
        staffId: r.staff_id,
        start: r.start_at,
        end: r.end_at,
        kind: r.kind,
        reason: `${r.kind} ${r.id}`,
      }));
    },

    async getPolicies(slug) {
      const rows = await sql<PoliciesRow[]>`select ${policyColumns(sql)} from policies where shop_slug = ${slug}`;
      return rows[0] ? toPolicies(rows[0]) : null;
    },

    async savePolicies(slug, p) {
      const rows = await sql<PoliciesRow[]>`
        insert into policies (
          shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone,
          deposit_rule, late_cancel_rule, no_show_rule
        ) values (
          ${slug}, ${p.leadTimeMin}, ${p.horizonDays}, ${p.depositHorizonDays}, ${p.cancelWindowHours}, ${p.paused},
          ${p.phone}, ${p.depositRule}, ${p.lateCancelRule}, ${p.noShowRule}
        )
        on conflict (shop_slug) do update set
          lead_time_min = excluded.lead_time_min,
          horizon_days = excluded.horizon_days,
          deposit_horizon_days = excluded.deposit_horizon_days,
          cancel_window_hours = excluded.cancel_window_hours,
          paused = excluded.paused,
          phone = excluded.phone,
          deposit_rule = excluded.deposit_rule,
          late_cancel_rule = excluded.late_cancel_rule,
          no_show_rule = excluded.no_show_rule,
          updated_at = now()
        returning ${policyColumns(sql)}
      `;
      if (!rows[0]) throw new Error("Upsert into policies returned no row.");
      return toPolicies(rows[0]);
    },

    async replaceWeeklyHours(slug, staffId, weekly) {
      const replace = async (tx: postgres.TransactionSql) => {
        // Locking the staff row serializes concurrent replacements of the same week.
        const member = await tx`select id from staff where id = ${staffId} and shop_slug = ${slug} for update`;
        if (member.length === 0) return false;
        await tx`delete from weekly_hours where staff_id = ${staffId}`;
        if (weekly.length > 0) {
          const rows = weekly.map((w) => ({ staff_id: staffId, weekday: w.weekday, opens: w.open, closes: w.close }));
          await tx`insert into weekly_hours ${tx(rows, "staff_id", "weekday", "opens", "closes")}`;
        }
        return true;
      };
      // Atomic either way: its own transaction on the root client, a savepoint inside one.
      return conn.kind === "root" ? conn.sql.begin(replace) : conn.sql.savepoint(replace);
    },

    async listBlocks(slug, range) {
      const rows = await sql<BlockRow[]>`
        select bt.id::text as id, bt.staff_id, lower(bt.during) as start_at, upper(bt.during) as end_at,
               bt.reason, sh.timezone
        from blocked_times bt
        join staff s on s.id = bt.staff_id
        join shops sh on sh.slug = s.shop_slug
        where s.shop_slug = ${slug} and bt.during && ${tstzrange(sql, range)}
        order by lower(bt.during), bt.id
      `;
      return rows.map(toBlock);
    },

    async createBlock(slug, block) {
      // Inserts nothing (and returns no row) when the staff member isn't in the shop.
      const rows = await sql<BlockRow[]>`
        with s as (
          select st.id, sh.timezone
          from staff st join shops sh on sh.slug = st.shop_slug
          where st.id = ${block.staffId} and st.shop_slug = ${slug}
        ), bt as (
          insert into blocked_times (staff_id, during, reason)
          select s.id, ${tstzrange(sql, block)}, ${block.reason}::text from s
          returning *
        )
        select bt.id::text as id, bt.staff_id, lower(bt.during) as start_at, upper(bt.during) as end_at,
               bt.reason, s.timezone
        from bt join s on s.id = bt.staff_id
      `;
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async deleteBlock(slug, id) {
      const key = normalizeUuid(id);
      if (key === null) return null; // Postgres would raise 22P02 on a malformed uuid
      const rows = await sql<BlockRow[]>`
        delete from blocked_times bt
        using staff s, shops sh
        where bt.id = ${key}::uuid and s.id = bt.staff_id and s.shop_slug = ${slug} and sh.slug = s.shop_slug
        returning bt.id::text as id, bt.staff_id, lower(bt.during) as start_at, upper(bt.during) as end_at,
                  bt.reason, sh.timezone
      `;
      return rows[0] ? toBlock(rows[0]) : null;
    },

    async createService(slug, service) {
      try {
        const rows = await sql<ServiceRow[]>`
          insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
          select ${slug}::text, ${service.id}::text, ${service.name}::text, ${service.durationMin}::integer,
                 ${service.priceCents}::integer, ${service.depositCents}::integer, coalesce(max(position), 0) + 1
          from services where shop_slug = ${slug}
          returning id, name, duration_min, price_cents, deposit_cents
        `;
        if (!rows[0]) throw new Error("Insert into services returned no row.");
        return toService(rows[0]);
      } catch (err) {
        if (err instanceof postgres.PostgresError && err.code === UNIQUE_VIOLATION) {
          throw new DuplicateServiceError(service.id);
        }
        throw err;
      }
    },

    async updateService(slug, id, patch) {
      // Only the given fields change; a missing (or undefined) field keeps its value.
      const rows = await sql<ServiceRow[]>`
        update services set
          name = coalesce(${patch.name ?? null}::text, name),
          duration_min = coalesce(${patch.durationMin ?? null}::integer, duration_min),
          price_cents = coalesce(${patch.priceCents ?? null}::integer, price_cents),
          deposit_cents = coalesce(${patch.depositCents ?? null}::integer, deposit_cents)
        where shop_slug = ${slug} and id = ${id}
        returning id, name, duration_min, price_cents, deposit_cents
      `;
      return rows[0] ? toService(rows[0]) : null;
    },
  };
}

export function createPostgresStore(url: string): ShopCatalog & BookingStore {
  const root: Conn = { kind: "root", sql: getPostgresClient(url) };
  return { ...catalogOn(root), ...bookingStoreOn(root) };
}
