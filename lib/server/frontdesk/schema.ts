// Every table and column the Postgres stores (postgres-store.ts, and lib/server/oauth/postgres-store.ts for
// connector sign-in) read or write, in the `public` schema.
// GET /api/status compares this list with the database's information_schema: anything missing makes the
// schema "outdated" and is named in `missing` (e.g. "approvals.token").
//
// Keep it exact. schema.test.ts fails if postgres-store.ts names a column this list lacks, or if a
// listed column is no longer used. When a change makes the store use a new column, add it here in the
// same PR as the migration that creates it.
export const REQUIRED_SCHEMA = {
  shops: ["slug", "name", "timezone"],
  services: ["shop_slug", "id", "name", "duration_min", "price_cents", "deposit_cents", "position"],
  staff: ["id", "shop_slug", "name"],
  weekly_hours: ["staff_id", "weekday", "opens", "closes"],
  bookings: [
    "id",
    "shop_slug",
    "service_id",
    "staff_id",
    "during",
    "status",
    "customer_name",
    "agent_name",
    "created_at",
    "cancelled_at",
    "cancelled_by",
    "completed_at",
    "no_show_at",
    "deposit_cents",
    "approve_by",
    "customer_phone",
    "mandate",
    "checkout_session_id",
    "checkout_url",
    "payment_intent_id",
    "pay_by",
    "deposit_state",
    "deposit_failure",
    "agent_client_id",
    "customer_id",
  ],
  approvals: ["booking_id", "token", "decision", "decided_at"],
  events: ["id", "booking_id", "at", "actor", "type", "data"],
  policies: [
    "shop_slug",
    "lead_time_min",
    "horizon_days",
    "deposit_horizon_days",
    "cancel_window_hours",
    "paused",
    "phone",
    "deposit_rule",
    "late_cancel_rule",
    "no_show_rule",
    "owner_email",
    "owner_mobile",
    "updated_at",
  ],
  blocked_times: ["id", "staff_id", "during", "reason"],
  alerts: ["id", "shop_slug", "booking_id", "kind", "channel", "recipient", "status", "error", "created_at"],
  nightly_runs: ["id", "ran_at", "expired", "completed", "deposits_released", "failures"],
  agents: ["client_id", "name", "first_seen", "last_seen"],
  owner_codes: ["id", "shop_slug", "code", "sent_to", "expires_at", "used_at"],
  // Connector sign-in (0008_signin.sql), queried by lib/server/oauth/postgres-store.ts.
  customers: ["id", "shop_slug", "name", "phone", "updated_at"],
  oauth_clients: ["shop_slug", "client_id", "kind", "client_name", "redirect_uris", "fetched_at"],
  oauth_codes: [
    "code",
    "shop_slug",
    "client_id",
    "customer_id",
    "redirect_uri",
    "code_challenge",
    "scope",
    "resource",
    "expires_at",
    "used_at",
  ],
  oauth_tokens: ["token", "kind", "shop_slug", "client_id", "customer_id", "scope", "resource", "expires_at"],
} as const satisfies Record<string, readonly string[]>;

export type RequiredTable = keyof typeof REQUIRED_SCHEMA;

/** The tables in REQUIRED_SCHEMA. */
export const REQUIRED_TABLES = Object.keys(REQUIRED_SCHEMA) as RequiredTable[];

/** A column that exists in the database. */
export type PresentColumn = { table: string; column: string };

/**
 * What REQUIRED_SCHEMA needs that `present` lacks, in list order: "table.column" for a missing column, or
 * the bare table name when none of its columns exist (the table itself is missing).
 */
export function missingFromSchema(present: Iterable<PresentColumn>): string[] {
  const columns = new Set<string>();
  const tables = new Set<string>();
  for (const { table, column } of present) {
    columns.add(`${table}.${column}`);
    tables.add(table);
  }
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) {
      missing.push(table);
      continue;
    }
    for (const column of REQUIRED_SCHEMA[table] as readonly string[]) {
      if (!columns.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
    }
  }
  return missing;
}
