import postgres from "postgres";
import type { Booking, BookingStatus } from "../../types/frontdesk";
import {
  SlotTakenError,
  toBooking,
  type BookingRecord,
  type BookingStore,
  type NewBooking,
} from "./booking-store";
import type { BusyInterval, ShopCatalog, StaffHours, WeeklyHours } from "./catalog";

// Postgres ShopCatalog + BookingStore (postgres.js), for the schema in
// supabase/migrations/0001_skeleton.sql.

/** SQLSTATE exclusion_violation: the bookings.no_overlap constraint fired. */
const EXCLUSION_VIOLATION = "23P01";
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

export function createPostgresStore(url: string): ShopCatalog & BookingStore {
  const sql = getPostgresClient(url);

  // Bookings joined with the service and shop details a Booking shows. `b` is bookings or a CTE
  // with the same columns. Built fresh for each query.
  const bookingColumns = () => sql`
    b.id::text as id, b.shop_slug, b.service_id, sv.name as service_name, sv.deposit_cents,
    b.staff_id, lower(b.during) as start_at, upper(b.during) as end_at, b.status,
    b.customer_name, b.agent_name, b.created_at, sh.timezone
  `;
  const bookingJoins = () => sql`
    join services sv on sv.shop_slug = b.shop_slug and sv.id = b.service_id
    join shops sh on sh.slug = b.shop_slug
  `;

  /** One INSERT … RETURNING, joined for the Booking's service and shop details. */
  async function insertBooking(input: NewBooking): Promise<Booking> {
    const rows = await sql<BookingRow[]>`
      with b as (
        insert into bookings (shop_slug, service_id, staff_id, during, status, customer_name, agent_name)
        values (
          ${input.shopSlug}, ${input.serviceId}, ${input.staffId},
          tstzrange(${input.start.toISOString()}::timestamptz, ${input.end.toISOString()}::timestamptz, '[)'),
          'confirmed', ${input.customerName}, ${input.agentName}
        )
        returning *
      )
      select ${bookingColumns()} from b ${bookingJoins()}
    `;
    if (!rows[0]) throw new Error("Insert into bookings returned no row.");
    return toBooking(toRecord(rows[0]));
  }

  return {
    async getShop(slug) {
      const rows = await sql<{ slug: string; name: string; timezone: string }[]>`
        select slug, name, timezone from shops where slug = ${slug}
      `;
      return rows[0] ? { slug: rows[0].slug, name: rows[0].name, timezone: rows[0].timezone } : null;
    },

    async listServices(slug) {
      const rows = await sql<
        { id: string; name: string; duration_min: number; price_cents: number; deposit_cents: number }[]
      >`
        select id, name, duration_min, price_cents, deposit_cents
        from services where shop_slug = ${slug}
        order by position, id
      `;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        durationMin: r.duration_min,
        priceCents: r.price_cents,
        depositCents: r.deposit_cents,
      }));
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
      // Weekly hours already leave out lunch, so busy time is just confirmed bookings.
      const rows = await sql<{ id: string; staff_id: string; start_at: Date; end_at: Date }[]>`
        select id::text as id, staff_id, lower(during) as start_at, upper(during) as end_at
        from bookings
        where shop_slug = ${slug}
          and status = 'confirmed'
          and during && tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')
        order by lower(during), id
      `;
      return rows.map((r) => ({
        staffId: r.staff_id,
        start: r.start_at,
        end: r.end_at,
        reason: `booking ${r.id}`,
      }));
    },

    async createBooking(input) {
      // Two overlapping inserts that arrive together can deadlock: an exclusion constraint is
      // checked after the row is inserted, so each insert waits to see whether the other commits.
      // Postgres aborts one with 40P01 (after deadlock_timeout, 1 s by default). Retrying it sees the
      // winner's committed row and fails cleanly with 23P01. If it still deadlocks after
      // MAX_INSERT_ATTEMPTS, other overlapping inserts are winning, so the slot is taken.
      for (let attempt = 1; ; attempt++) {
        try {
          return await insertBooking(input);
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
      const rows = await sql<BookingRow[]>`
        select ${bookingColumns()}
        from bookings b ${bookingJoins()}
        where b.shop_slug = ${shopSlug}
          and b.during && tstzrange(${range.start.toISOString()}::timestamptz, ${range.end.toISOString()}::timestamptz, '[)')
        order by lower(b.during), b.id
      `;
      return rows.map((r) => toBooking(toRecord(r)));
    },
  };
}
