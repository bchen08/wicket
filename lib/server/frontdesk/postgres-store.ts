import postgres from "postgres";
import type {
  AlertChannel,
  AlertKind,
  AlertStatus,
  BlockedTime,
  Booking,
  BookingActor,
  BookingEventType,
  BookingStatus,
  DepositState,
  Mandate,
  Policies,
  Service,
} from "../../types/frontdesk";
import {
  normalizeUuid,
  SlotTakenError,
  toAlert,
  toBooking,
  toBookingEvent,
  toNightlyRun,
  type AnswerApprovalResult,
  type BookingRecord,
  type BookingStore,
  type DepositFailure,
  type DepositPatch,
  type NewBooking,
} from "./booking-store";
import {
  DepositExceedsPriceError,
  DuplicateServiceError,
  toBlockedTime,
  type BusyInterval,
  type ShopCatalog,
  type StaffHours,
  type TimeRange,
  type WeeklyHours,
} from "./catalog";

// Postgres ShopCatalog + BookingStore (postgres.js), for the schema in
// supabase/migrations/0001_skeleton.sql, 0002_rules.sql, 0003_consent.sql, 0004_alerts.sql, 0005_deposits.sql
// and 0006_nightly.sql; bookings.customer_id is from 0008_signin.sql.

/** SQLSTATE exclusion_violation: the bookings.no_overlap constraint fired. */
const EXCLUSION_VIOLATION = "23P01";
/** SQLSTATE unique_violation: e.g. a services primary key clash. */
const UNIQUE_VIOLATION = "23505";
/** SQLSTATE check_violation. See depositError. */
const CHECK_VIOLATION = "23514";
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
 * Where a store's queries run: the root client, or one transaction (the store a transactional method
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
  customer_approved: boolean;
  customer_phone: string | null;
  approval_token: string | null;
  approve_by: Date | null;
  deposit_state: DepositState;
  checkout_url: string | null;
  pay_by: Date | null;
  /** jsonb: { action, message, at } with `at` an ISO string. */
  deposit_failure: { action: DepositFailure["action"]; message: string; at: string } | null;
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
    customerApproved: r.customer_approved,
    customerPhone: r.customer_phone,
    approvalToken: r.approval_token,
    approveBy: r.approve_by,
    depositState: r.deposit_state,
    checkoutUrl: r.checkout_url,
    payBy: r.pay_by,
    depositFailure: r.deposit_failure
      ? { action: r.deposit_failure.action, message: r.deposit_failure.message, at: new Date(r.deposit_failure.at) }
      : null,
    timezone: r.timezone,
  };
}

/** A DepositPatch's columns as query parameters: null keeps the stored value (coalesce). */
function patchParams(patch: DepositPatch | undefined) {
  return {
    state: patch?.state ?? null,
    sessionId: patch?.checkoutSessionId ?? null,
    url: patch?.checkoutUrl ?? null,
    intentId: patch?.paymentIntentId ?? null,
    payBy: patch?.payBy?.toISOString() ?? null,
  };
}

/** Thrown inside answerApproval's transaction to roll it back. */
class AnswerRollback extends Error {
  readonly reason = "not_pending" as const;
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
  owner_email: string | null;
};

/** `patch` without its undefined fields, so spreading it never overwrites a value with undefined. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** DepositExceedsPriceError if `err` is the services_deposit_le_price check firing, else null. */
function depositError(err: unknown, serviceId: string): DepositExceedsPriceError | null {
  return err instanceof postgres.PostgresError &&
    err.code === CHECK_VIOLATION &&
    err.constraint_name === "services_deposit_le_price"
    ? new DepositExceedsPriceError(serviceId)
    : null;
}

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
    ownerEmail: r.owner_email,
  };
}

// Query fragments. Built fresh for each query, on the connection that runs it.

/** A half-open tstzrange literal for `range`. */
const tstzrange = (db: Db, range: TimeRange) =>
  db`tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')`;

/**
 * The columns of a Booking. `b` is bookings or a CTE with the same columns; depositCents is the
 * booking's own snapshot, and the service name and the approval (decision, token) are joined in by
 * bookingJoins.
 */
const bookingColumns = (db: Db) => db`
  b.id::text as id, b.shop_slug, b.service_id, sv.name as service_name, b.deposit_cents,
  b.staff_id, lower(b.during) as start_at, upper(b.during) as end_at, b.status,
  b.customer_name, b.agent_name, b.created_at, coalesce(ap.decision = 'approved', false) as customer_approved,
  b.customer_phone, ap.token as approval_token, b.approve_by,
  b.deposit_state, b.checkout_url, b.pay_by, b.deposit_failure, sh.timezone
`;
const bookingJoins = (db: Db) => db`
  join services sv on sv.shop_slug = b.shop_slug and sv.id = b.service_id
  join shops sh on sh.slug = b.shop_slug
  left join approvals ap on ap.booking_id = b.id
`;

/** An "expired" event's data for an expiring row `x` (see expiredEventData in booking-store.ts, which the memory store uses). */
const expiredEventJson = (db: Db) => db`
  jsonb_build_object(
    'from', 'awaiting_approval', 'to', 'expired',
    'depositEffect', case when x.deposit_cents > 0 then 'released' else 'none' end,
    'depositCollected', false
  )
`;

const policyColumns = (db: Db) => db`
  lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone,
  deposit_rule, late_cancel_rule, no_show_rule, owner_email
`;

type AlertRow = {
  id: string;
  shop_slug: string;
  booking_id: string;
  kind: AlertKind;
  channel: AlertChannel;
  recipient: string | null;
  status: AlertStatus;
  error: string | null;
  created_at: Date;
  timezone: string;
};

const toAlertFromRow = (r: AlertRow) =>
  toAlert({
    id: r.id,
    shopSlug: r.shop_slug,
    bookingId: r.booking_id,
    kind: r.kind,
    channel: r.channel,
    recipient: r.recipient,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    timezone: r.timezone,
  });

type NightlyRunRow = { ran_at: Date; expired: number; completed: number; deposits_released: number; failures: number };

const toNightlyRunFromRow = (r: NightlyRunRow) =>
  toNightlyRun({
    ranAt: r.ran_at,
    expired: r.expired,
    completed: r.completed,
    depositsReleased: r.deposits_released,
    failures: r.failures,
  });

/** The columns of an Alert. `a` is alerts or a CTE with the same columns, joined to shops as `sh`. */
const alertColumns = (db: Db) => db`
  a.id::text as id, a.shop_slug, a.booking_id::text as booking_id, a.kind, a.channel, a.recipient,
  a.status, a.error, a.created_at, sh.timezone
`;

/**
 * One statement: insert the held booking with its deposit snapshot, deadline and mandate, its approval
 * request and its "booked" event (data-modifying CTEs), and return the joined Booking.
 */
async function insertBooking(db: Db, input: NewBooking): Promise<Booking> {
  const mandate = input.mandate ? db.json(input.mandate as postgres.JSONValue) : null;
  const rows = await db<BookingRow[]>`
    with b as (
      insert into bookings (
        shop_slug, service_id, staff_id, during, status, customer_name, agent_name, deposit_cents, approve_by, mandate,
        customer_id, customer_phone
      )
      values (
        ${input.shopSlug}, ${input.serviceId}, ${input.staffId}, ${tstzrange(db, input)},
        'awaiting_approval', ${input.customerName}, ${input.agentName}, ${input.depositCents},
        ${input.approveBy.toISOString()}::timestamptz, ${mandate}::jsonb,
        ${normalizeUuid(input.customerId ?? "")}::uuid, ${input.customerPhone ?? null}::text
      )
      returning *
    ), a as (
      insert into approvals (booking_id, token) select id, ${input.approvalToken}::text from b
      returning booking_id, token, decision
    ), e as (
      insert into events (booking_id, actor, type, data)
      select id, 'agent', 'booked',
             jsonb_build_object('status', status, 'agentName', agent_name)
               || case when mandate is null then '{}'::jsonb else jsonb_build_object('mandate', mandate) end
      from b
    )
    select ${bookingColumns(db)}
    from b
    join services sv on sv.shop_slug = b.shop_slug and sv.id = b.service_id
    join shops sh on sh.slug = b.shop_slug
    join a ap on ap.booking_id = b.id
  `;
  if (!rows[0]) throw new Error("Insert into bookings returned no row.");
  return toBooking(toRecord(rows[0]));
}

/** The BookingStore methods over `conn` (in practice the root client). */
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

    async listBookings(shopSlug, range, statuses) {
      const rows = await db<BookingRow[]>`
        select ${bookingColumns(db)}
        from bookings b ${bookingJoins(db)}
        where b.shop_slug = ${shopSlug} and b.during && ${tstzrange(db, range)}
          ${statuses ? db`and b.status in ${db([...statuses])}` : db``}
        order by lower(b.during), b.id
      `;
      return rows.map((r) => toBooking(toRecord(r)));
    },

    async listCustomerBookings(shopSlug, customerId, since, limit) {
      const customer = normalizeUuid(customerId);
      if (customer === null) return [];
      const rows = await db<BookingRow[]>`
        select ${bookingColumns(db)}
        from bookings b ${bookingJoins(db)}
        where b.shop_slug = ${shopSlug} and b.customer_id = ${customer}::uuid
          and upper(b.during) > ${since.toISOString()}::timestamptz
        order by lower(b.during), b.id
        limit ${limit}
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

    async refreshBooking(id, now) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      // One statement, so the expiry, its event and the read are atomic. The second branch reads the
      // row only when the first expired nothing (a data-modifying CTE's changes aren't visible to the
      // rest of the statement, so it would show the old status).
      const rows = await db<BookingRow[]>`
        with x as (
          update bookings set status = 'expired'
          where id = ${key}::uuid and status = 'awaiting_approval' and approve_by <= ${now.toISOString()}::timestamptz
          returning *
        ), e as (
          insert into events (booking_id, actor, type, data) select x.id, 'system', 'expired', ${expiredEventJson(db)} from x
        )
        select ${bookingColumns(db)} from x b ${bookingJoins(db)}
        union all
        select ${bookingColumns(db)} from bookings b ${bookingJoins(db)}
        where b.id = ${key}::uuid and not exists (select 1 from x)
      `;
      return rows[0] ? toBooking(toRecord(rows[0])) : null;
    },

    async expireStaleHolds(shopSlug, range, now) {
      // Of two concurrent expiries the second waits for the first's row locks, re-checks the status
      // and skips the rows already expired, so each hold gets exactly one event.
      const [row] = await db<{ n: number }[]>`
        with x as (
          update bookings set status = 'expired'
          where shop_slug = ${shopSlug} and status = 'awaiting_approval'
            and approve_by <= ${now.toISOString()}::timestamptz and during && ${tstzrange(db, range)}
          returning id, deposit_cents
        ), e as (
          insert into events (booking_id, actor, type, data) select x.id, 'system', 'expired', ${expiredEventJson(db)} from x
        )
        select count(*)::int as n from x
      `;
      return row?.n ?? 0;
    },

    async transition(id, expectedStatus, nextStatus, event, deposit) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      const d = patchParams(deposit);
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
            no_show_at = case when ${nextStatus === "no_show"} then now() else no_show_at end,
            deposit_state = coalesce(${d.state}::text, deposit_state),
            checkout_session_id = coalesce(${d.sessionId}::text, checkout_session_id),
            checkout_url = coalesce(${d.url}::text, checkout_url),
            payment_intent_id = coalesce(${d.intentId}::text, payment_intent_id),
            pay_by = coalesce(${d.payBy}::timestamptz, pay_by)
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

    // ---- Ring 1b: consent ----

    async findApproval(token) {
      const rows = await db<{ booking_id: string; decision: "approved" | "declined" | null; approve_by: Date | null; mandate: Mandate | null }[]>`
        select a.booking_id::text as booking_id, a.decision, b.approve_by, b.mandate
        from approvals a join bookings b on b.id = a.booking_id
        where a.token = ${token}
      `;
      const r = rows[0];
      if (!r || !r.approve_by) return null;
      return { bookingId: r.booking_id, decision: r.decision, approveBy: r.approve_by, mandate: r.mandate };
    },

    async answerApproval(input) {
      const key = normalizeUuid(input.bookingId);
      if (key === null) return { ok: false, reason: "not_pending" };
      const now = input.now.toISOString();
      const answer = async (tx: postgres.TransactionSql): Promise<Booking> => {
        const decided = await tx`
          update approvals set decision = ${input.decision}, decided_at = ${now}::timestamptz
          where booking_id = ${key}::uuid and decided_at is null
          returning booking_id
        `;
        if (decided.length === 0) throw new AnswerRollback();
        const phone = input.decision === "approved" ? (input.phone ?? null) : null;
        const d = patchParams(input.decision === "approved" ? input.deposit : undefined);
        const rows = await tx<BookingRow[]>`
          with t as (
            update bookings set
              status = ${input.nextStatus},
              customer_phone = coalesce(${phone}::text, customer_phone),
              deposit_state = coalesce(${d.state}::text, deposit_state),
              checkout_session_id = coalesce(${d.sessionId}::text, checkout_session_id),
              checkout_url = coalesce(${d.url}::text, checkout_url),
              payment_intent_id = coalesce(${d.intentId}::text, payment_intent_id),
              pay_by = coalesce(${d.payBy}::timestamptz, pay_by),
              cancelled_at = case when ${input.nextStatus === "cancelled"} then now() else cancelled_at end,
              cancelled_by = case when ${input.nextStatus === "cancelled"} then 'customer' else cancelled_by end
            where id = ${key}::uuid and status = 'awaiting_approval' and approve_by > ${now}::timestamptz
            returning *
          ), e as (
            insert into events (booking_id, actor, type, data)
            select id, ${input.event.actor}::text, ${input.event.type}::text, ${tx.json(input.event.data as postgres.JSONValue)}::jsonb from t
          )
          select ${bookingColumns(tx)} from t b ${bookingJoins(tx)}
        `;
        if (!rows[0]) throw new AnswerRollback();
        return toBooking(toRecord(rows[0]));
      };
      try {
        const booking = await (conn.kind === "root" ? conn.sql.begin(answer) : conn.sql.savepoint(answer));
        return { ok: true, booking } satisfies AnswerApprovalResult;
      } catch (err) {
        if (err instanceof AnswerRollback) return { ok: false, reason: err.reason };
        throw err;
      }
    },

    // ---- Ring 1c: deposits ----

    async getDeposit(id) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      const rows = await db<
        { deposit_state: DepositState; checkout_session_id: string | null; payment_intent_id: string | null; pay_by: Date | null }[]
      >`
        select deposit_state, checkout_session_id, payment_intent_id, pay_by from bookings where id = ${key}::uuid
      `;
      const r = rows[0];
      if (!r) return null;
      return {
        state: r.deposit_state,
        checkoutSessionId: r.checkout_session_id,
        paymentIntentId: r.payment_intent_id,
        payBy: r.pay_by,
      };
    },

    async updateDeposit(id, outcome, event) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      const failure =
        outcome.failure === undefined || outcome.failure === null
          ? null
          : db.json({ action: outcome.failure.action, message: outcome.failure.message, at: outcome.failure.at.toISOString() });
      // One statement, so the outcome and its event commit together.
      const rows = await db<BookingRow[]>`
        with t as (
          update bookings set
            deposit_state = coalesce(${outcome.state ?? null}::text, deposit_state),
            deposit_failure = case when ${outcome.failure !== undefined} then ${failure}::jsonb else deposit_failure end
          where id = ${key}::uuid
          returning *
        ), e as (
          insert into events (booking_id, actor, type, data)
          select id, ${event?.actor ?? "system"}::text, ${event?.type ?? ""}::text, ${db.json((event?.data ?? {}) as postgres.JSONValue)}::jsonb
          from t where ${event !== undefined}
        )
        select ${bookingColumns(db)} from t b ${bookingJoins(db)}
      `;
      return rows[0] ? toBooking(toRecord(rows[0])) : null;
    },

    // ---- Owner alerts ----

    async recordAlert(alert) {
      const key = normalizeUuid(alert.bookingId);
      if (key === null) throw new Error(`Alert for a booking id that isn't a UUID: ${alert.bookingId}`);
      const rows = await db<AlertRow[]>`
        with a as (
          insert into alerts (shop_slug, booking_id, kind, channel, recipient, status, error)
          values (
            ${alert.shopSlug}, ${key}::uuid, ${alert.kind}, ${alert.channel}, ${alert.recipient},
            ${alert.status}, ${alert.error}
          )
          returning *
        )
        select ${alertColumns(db)} from a join shops sh on sh.slug = a.shop_slug
      `;
      if (!rows[0]) throw new Error("Insert into alerts returned no row.");
      return toAlertFromRow(rows[0]);
    },

    async listAlerts(shopSlug, limit) {
      const rows = await db<AlertRow[]>`
        select ${alertColumns(db)}
        from alerts a join shops sh on sh.slug = a.shop_slug
        where a.shop_slug = ${shopSlug}
        order by a.created_at desc, a.id desc
        limit ${limit}
      `;
      return rows.map(toAlertFromRow);
    },

    // ---- The nightly tidy-up ----

    async recordNightlyRun(counts) {
      const rows = await db<NightlyRunRow[]>`
        insert into nightly_runs (expired, completed, deposits_released, failures)
        values (${counts.expired}, ${counts.completed}, ${counts.depositsReleased}, ${counts.failures})
        returning ran_at, expired, completed, deposits_released, failures
      `;
      if (!rows[0]) throw new Error("Insert into nightly_runs returned no row.");
      return toNightlyRunFromRow(rows[0]);
    },

    async lastNightlyRun() {
      const rows = await db<NightlyRunRow[]>`
        select ran_at, expired, completed, deposits_released, failures
        from nightly_runs
        order by ran_at desc, id desc
        limit 1
      `;
      return rows[0] ? toNightlyRunFromRow(rows[0]) : null;
    },
  };
  return store;
}

/**
 * The ShopCatalog methods over `conn` (in practice the root client; the savepoint branches keep owner
 * writes atomic if one ever runs inside a transaction).
 */
function catalogOn(conn: Conn): ShopCatalog {
  const sql: Db = conn.sql;
  return {
    async listShops() {
      const rows = await sql<{ slug: string; name: string; timezone: string }[]>`
        select slug, name, timezone from shops order by slug
      `;
      return rows.map((r) => ({ slug: r.slug, name: r.name, timezone: r.timezone }));
    },

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
      // in the no_overlap constraint; a hold carries its deadline, approve_by or pay_by) plus blocked
      // times. Ordered by start, then kind, then id.
      const rows = await sql<
        { kind: "booking" | "block"; id: string; staff_id: string; start_at: Date; end_at: Date; held_until: Date | null }[]
      >`
        select busy.kind, busy.id::text as id, busy.staff_id, busy.start_at, busy.end_at, busy.held_until
        from (
          select 'booking' as kind, b.id, b.staff_id, lower(b.during) as start_at, upper(b.during) as end_at,
                 case when b.status = 'awaiting_approval' then b.approve_by
                      when b.status = 'awaiting_deposit' then b.pay_by end as held_until
          from bookings b
          where b.shop_slug = ${slug}
            and b.status in ('awaiting_approval', 'awaiting_deposit', 'confirmed')
            and b.during && ${tstzrange(sql, range)}
          union all
          select 'block', bt.id, bt.staff_id, lower(bt.during), upper(bt.during), null
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
        ...(r.held_until ? { heldUntil: r.held_until } : {}),
      }));
    },

    async getPolicies(slug) {
      const rows = await sql<PoliciesRow[]>`select ${policyColumns(sql)} from policies where shop_slug = ${slug}`;
      return rows[0] ? toPolicies(rows[0]) : null;
    },

    async savePolicies(slug, patch) {
      const save = async (tx: postgres.TransactionSql) => {
        // A shop without a row gets one with the column defaults. Then the row is locked from the read
        // to the write, so a concurrent savePolicies waits here and merges onto this one's result.
        await tx`insert into policies (shop_slug) values (${slug}) on conflict (shop_slug) do nothing`;
        const [stored] = await tx<PoliciesRow[]>`
          select ${policyColumns(tx)} from policies where shop_slug = ${slug} for update
        `;
        if (!stored) throw new Error("Select from policies returned no row.");
        // Absent or undefined fields keep their stored values; phone: null clears the phone, ownerEmail: null the email.
        const p: Policies = { ...toPolicies(stored), ...defined(patch) };
        const rows = await tx<PoliciesRow[]>`
          update policies set
            lead_time_min = ${p.leadTimeMin},
            horizon_days = ${p.horizonDays},
            deposit_horizon_days = ${p.depositHorizonDays},
            cancel_window_hours = ${p.cancelWindowHours},
            paused = ${p.paused},
            phone = ${p.phone},
            deposit_rule = ${p.depositRule},
            late_cancel_rule = ${p.lateCancelRule},
            no_show_rule = ${p.noShowRule},
            owner_email = ${p.ownerEmail},
            updated_at = now()
          where shop_slug = ${slug}
          returning ${policyColumns(tx)}
        `;
        if (!rows[0]) throw new Error("Update of policies returned no row.");
        return toPolicies(rows[0]);
      };
      // Atomic either way: its own transaction on the root client, a savepoint inside one.
      return conn.kind === "root" ? conn.sql.begin(save) : conn.sql.savepoint(save);
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
        throw depositError(err, service.id) ?? err;
      }
    },

    async updateService(slug, id, patch) {
      // Only the given fields change; a missing (or undefined) field keeps its value. The SET reads the
      // row as it is when the update applies (a concurrent update's result, after its row lock), and
      // the services_deposit_le_price check judges that merged row.
      try {
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
      } catch (err) {
        throw depositError(err, id) ?? err;
      }
    },
  };
}

export function createPostgresStore(url: string): ShopCatalog & BookingStore {
  const root: Conn = { kind: "root", sql: getPostgresClient(url) };
  return { ...catalogOn(root), ...bookingStoreOn(root) };
}
