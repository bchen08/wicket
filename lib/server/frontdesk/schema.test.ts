import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingFromSchema, REQUIRED_SCHEMA, REQUIRED_TABLES } from "./schema";

// REQUIRED_SCHEMA must name every table and column the Postgres stores (postgres-store.ts and
// lib/server/oauth/postgres-store.ts) read or write, and nothing else:
// GET /api/status reports the schema "current" only when all of them exist, so a column the list lacks
// would let an outdated database pass, and an extra one would block a good one.
//
// The check reads the store's SQL (its db`…`, sql`…`, tx`…` and sp`…` templates) and sorts every word into:
// a SQL keyword or function (SQL_WORDS below), an alias the SQL itself declares, or a table or column,
// which must be in REQUIRED_SCHEMA.

/** SQL keywords, functions and types the store uses. Add one here if a new query needs it. */
const SQL_WORDS = new Set([
  "all", "and", "any", "as", "asc", "by", "case", "coalesce", "conflict", "count", "delete", "desc", "distinct",
  "do", "else", "end", "excluded", "exists", "false", "for", "from", "in", "insert", "int", "integer", "into", "is", "join",
  "jsonb", "jsonb_build_object", "left", "limit", "lower", "max", "not", "nothing", "now", "null", "on", "or",
  "order", "returning", "select", "set", "text", "timestamptz", "to_char", "true", "tstzrange", "union",
  "update", "upper", "using", "uuid", "values", "when", "where", "with", "then",
]);

const STORE_FILES = [join(__dirname, "postgres-store.ts"), join(__dirname, "..", "oauth", "postgres-store.ts")];
const SQL_TAG = /\b(?:db|sql|tx|sp)\s*(?:<[^`]*>)?\s*$/;

/** The text of every SQL template in `source`, with its interpolations and the quoted names inside `sql(rows, "a", "b")`. */
function sqlTemplates(source: string): { text: string; helperNames: string[] }[] {
  const templates: { text: string; helperNames: string[] }[] = [];
  let i = 0;
  while ((i = source.indexOf("`", i)) !== -1) {
    const isSql = SQL_TAG.test(source.slice(Math.max(0, i - 400), i));
    let j = i + 1;
    let text = "";
    const helperNames: string[] = [];
    while (j < source.length && source[j] !== "`") {
      if (source[j] === "$" && source[j + 1] === "{") {
        // Skip the interpolation (balanced braces), keeping names passed as strings to a helper such as
        // tx(rows, "staff_id", "weekday"): those are columns too.
        let depth = 1;
        let k = j + 2;
        while (k < source.length && depth > 0) {
          if (source[k] === "{") depth++;
          else if (source[k] === "}") depth--;
          k++;
        }
        const inner = source.slice(j + 2, k - 1);
        if (/^\s*(?:db|sql|tx|sp)\(/.test(inner)) {
          for (const m of inner.matchAll(/"([a-z_][a-z0-9_]*)"/g)) helperNames.push(m[1]);
        }
        text += " ";
        j = k;
      } else {
        text += source[j];
        j++;
      }
    }
    if (isSql) templates.push({ text, helperNames });
    i = j + 1;
  }
  return templates;
}

/**
 * The words in the SQL that aren't keywords or string literals: `tokens` is all of them, and `names` leaves
 * out the aliases the SQL declares, so what's left must be tables and columns.
 */
function sqlWords(templates: { text: string; helperNames: string[] }[]): { names: Set<string>; tokens: Set<string> } {
  const names = new Set<string>();
  const tokens = new Set<string>();
  const aliases = new Set<string>();
  const bodies = templates.map(({ text }) =>
    text
      .toLowerCase()
      .replace(/'(?:[^']|'')*'/g, " ") // string literals
      .replace(/::\s*[a-z_]+/g, " "), // casts
  );
  for (const body of bodies) {
    // Declared names: column aliases (… as name), CTEs (name as (…)), table aliases (from/join/using/,
    // table alias) and subquery aliases () alias).
    for (const m of body.matchAll(/\bas\s+([a-z_][a-z0-9_]*)/g)) aliases.add(m[1]);
    for (const m of body.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/g)) aliases.add(m[1]);
    for (const m of body.matchAll(/(?:\bfrom|\bjoin|\busing|,)\s+[a-z_][a-z0-9_]*\s+([a-z_][a-z0-9_]*)/g)) aliases.add(m[1]);
    for (const m of body.matchAll(/\)\s*([a-z_][a-z0-9_]*)/g)) aliases.add(m[1]);
  }
  for (const word of [...aliases]) if (SQL_WORDS.has(word)) aliases.delete(word);
  for (const body of bodies) {
    for (const m of body.matchAll(/[a-z_][a-z0-9_]*/g)) {
      if (SQL_WORDS.has(m[0])) continue;
      tokens.add(m[0]);
      if (!aliases.has(m[0])) names.add(m[0]);
    }
  }
  for (const t of templates) {
    for (const name of t.helperNames) {
      tokens.add(name);
      names.add(name);
    }
  }
  return { names, tokens };
}

const listed = new Set<string>([
  ...REQUIRED_TABLES,
  ...REQUIRED_TABLES.flatMap((table) => [...REQUIRED_SCHEMA[table]]),
]);

describe("REQUIRED_SCHEMA matches what the Postgres stores query", () => {
  const templates = STORE_FILES.flatMap((file) => sqlTemplates(readFileSync(file, "utf8")));
  const { names, tokens } = sqlWords(templates);

  it("finds the store's SQL", () => {
    expect(templates.length).toBeGreaterThan(20);
  });

  it("lists every table and column the store names", () => {
    const unlisted = [...names].filter((word) => !listed.has(word)).sort();
    // A word here is a column (or table) the store uses that REQUIRED_SCHEMA in schema.ts lacks: add it
    // there. If it's a SQL keyword or function instead, add it to SQL_WORDS in this file.
    expect(unlisted).toEqual([]);
  });

  it("lists nothing the store doesn't use", () => {
    const unused = [...listed].filter((word) => !tokens.has(word)).sort();
    // A word here is in REQUIRED_SCHEMA but no query uses it any more: remove it, or a database without
    // it would be called outdated.
    expect(unused).toEqual([]);
  });

  it("catches a query that names a column the list lacks", () => {
    const { names: words } = sqlWords([
      { text: "select b.id, b.reminder_sent_at as sent from bookings b where b.status = 'confirmed'", helperNames: [] },
    ]);
    expect([...words].filter((w) => !listed.has(w))).toEqual(["reminder_sent_at"]);
  });
});

describe("missingFromSchema", () => {
  const everything = REQUIRED_TABLES.flatMap((table) => REQUIRED_SCHEMA[table].map((column) => ({ table, column })));

  it("is empty when every listed column exists (extra columns don't matter)", () => {
    expect(missingFromSchema([...everything, { table: "bookings", column: "extra" }])).toEqual([]);
  });

  it("names a missing column as table.column", () => {
    const present = everything.filter((c) => !(c.table === "approvals" && c.column === "token"));
    expect(missingFromSchema(present)).toEqual(["approvals.token"]);
  });

  it("names a missing table once, by itself", () => {
    expect(missingFromSchema(everything.filter((c) => c.table !== "approvals"))).toEqual(["approvals"]);
  });

  it("names every table of an empty database", () => {
    expect(missingFromSchema([])).toEqual(REQUIRED_TABLES);
  });
});
