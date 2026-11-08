#!/usr/bin/env node
// pnpm smoke <base-url> [--commit <sha>] [--bypass <secret>] [--owner-token <token>]
//
// Runs every API check in SMOKE.md against one deployment and prints PASS / FAIL / SKIPPED with evidence,
// then one verdict line. Node 20+ and nothing else: no dependencies, no repo code imported.
//
// 1. Reads /api/status first. If the deployment isn't ready, or isn't at --commit, it prints
//    "BLOCKED: <problems>", runs nothing else and exits 2. BLOCKED means the environment isn't ready,
//    not that the code is wrong.
// 2. Read-only checks: health, services, owner access, errors, the MCP route, and the web booking API's
//    availability, agents.md and /.well-known/front-desk.json.
// 3. The booking loop, only where /api/status says writesAllowed (the Preview database, or in-memory
//    data): book → slot_taken → get_booking → decline → the slot is free again → the owner's alerts list
//    has booking_cancelled for it; then book a Beard trim (no deposit) → approve → the alerts list has
//    booking_confirmed for it. Then deposits: book another Haircut and approve it → awaiting_deposit with a
//    Stripe Checkout URL where /api/status says deposits "stripe_test" (it never pays), or confirmed with
//    the deposit not_collected where it says "off"; cancel it → the slot is free again. Then the web booking
//    API: a JSON book gets a link, a form post at that held start is sent back with ?error=slot_taken, the
//    JSON booking is declined, and a form post lands on /approve/<token>. Every booking it makes is declined
//    or cancelled at the end, even after a failure. Last, the nightly tidy-up: GET /api/jobs/nightly answers
//    its four counts, and /api/status shows that run as lastNightlyRun.
//    Its MCP requests and web bookings say they come from "front-desk-smoke", so the bookings show who
//    made them.
// 4. Feature checks: every scripts/smoke-checks/*.mjs, in name order (loadSmokeChecks). Each one's default
//    export is `async (ctx) => {}` and records its rows with ctx.check, like the checks here; it gets the same
//    client, /api/status, owner token and helpers (see the ctx object in runSmoke), and cleans up after itself.
//
// --bypass <secret> (or VERCEL_AUTOMATION_BYPASS_SECRET) sends Vercel's x-vercel-protection-bypass header
// on every request, for previews behind Vercel Authentication. --owner-token overrides the owner token,
// which is harts-preview on previews; elsewhere the owner 200 check is SKIPPED without it.
//
// Exit codes: 0 every check passed (some may be SKIPPED), 1 a check failed, 2 BLOCKED, 64 bad arguments.

import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const SMOKE_AGENT = "front-desk-smoke";
export const SMOKE_CUSTOMER = "Smoke Test";
/** The Preview environment's OWNER_API_TOKEN. Not a secret: production's value is different and private. */
export const PREVIEW_OWNER_TOKEN = "harts-preview";
export const UNLOCK_NEXT_ACTION = "Open /console/unlock and enter the shop's access code.";
export const BYPASS_HEADER = "x-vercel-protection-bypass";
export const EXIT = { pass: 0, fail: 1, blocked: 2, usage: 64 };

const SHOP_SERVICES = ["haircut", "beard-trim", "haircut-beard"];
const MCP_TOOLS = ["book", "cancel", "get_availability", "get_booking", "get_policies", "list_my_bookings", "list_services"];
/** Tool calls use the 2026-07-28 protocol, whose per-request _meta envelope carries clientInfo (the agent's name). */
const MCP_MODERN = "2026-07-28";
const MCP_LEGACY = "2025-06-18";
const REQUEST_TIMEOUT_MS = 15_000;
/** Haircut takes a deposit, and Hart's books those up to 6 days ahead. */
const BOOKING_WINDOW_DAYS = 6;
/** Where Stripe Checkout pages live (booking.deposit.payUrl). */
const STRIPE_CHECKOUT = "https://checkout.stripe.com/";

const USAGE = "Usage: pnpm smoke <base-url> [--commit <sha>] [--bypass <secret>] [--owner-token <token>]";

// ---- Arguments ----

/**
 * The options from the command line, or { error }. The bypass secret falls back to
 * VERCEL_AUTOMATION_BYPASS_SECRET.
 * @param {string[]} argv the arguments after the script name
 * @param {Record<string, string | undefined>} env
 */
export function parseArgs(argv, env = {}) {
  /** @type {{ baseUrl?: string, commit?: string, bypass?: string, ownerToken?: string }} */
  const options = {};
  const flags = { "--commit": "commit", "--bypass": "bypass", "--owner-token": "ownerToken" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { error: USAGE };
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const key = flags[name];
      if (!key) return { error: `Unknown option ${name}.\n${USAGE}` };
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
        return { error: `${name} needs a value.\n${USAGE}` };
      }
      options[key] = value;
    } else if (options.baseUrl === undefined) {
      options.baseUrl = arg;
    } else {
      return { error: `Unexpected argument ${arg}.\n${USAGE}` };
    }
  }
  if (!options.baseUrl) return { error: USAGE };
  let url;
  try {
    // A bare host gets https://, except a local one (pnpm dev, next start).
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(options.baseUrl);
    url = new URL(/^https?:\/\//i.test(options.baseUrl) ? options.baseUrl : `${local ? "http" : "https"}://${options.baseUrl}`);
  } catch {
    return { error: `${options.baseUrl} isn't a URL.\n${USAGE}` };
  }
  if (options.commit !== undefined && !/^[0-9a-f]{4,40}$/i.test(options.commit)) {
    return { error: `--commit must be a commit sha (4 to 40 hex characters), not ${options.commit}.` };
  }
  return {
    baseUrl: url.origin,
    commit: options.commit?.toLowerCase(),
    bypass: options.bypass ?? (env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || undefined),
    ownerToken: options.ownerToken,
  };
}

// ---- HTTP ----

function snippet(text, max = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** An error's message, with the network cause (e.g. ECONNREFUSED) when fetch hides it behind "fetch failed". */
function errorText(err) {
  const cause = err?.cause?.code ?? err?.cause?.message;
  return `${err?.message ?? err}${cause ? ` (${cause})` : ""}`;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether a response is Vercel Authentication's login wall rather than the app. */
export function isVercelLoginWall(res) {
  if (res.status >= 300 && res.status < 400) {
    return /vercel\.com|\/sso-api|_vercel_sso|\.well-known\/vercel/i.test(res.headers.get("location") ?? "");
  }
  if (res.status === 401 || res.status === 403) {
    const html = (res.headers.get("content-type") ?? "").includes("text/html");
    return (html && /vercel/i.test(res.text)) || /_vercel_sso/i.test(res.headers.get("set-cookie") ?? "");
  }
  return false;
}

function createClient({ baseUrl, bypass, fetchImpl }) {
  let nextId = 1;

  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    if (bypass) headers.set(BYPASS_HEADER, bypass);
    const res = await fetchImpl(new URL(path, baseUrl).href, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: tryJson(text) };
  }

  /** The JSON-RPC message in an MCP response: plain JSON, or the first SSE event carrying a result or error. */
  function mcpMessage(text) {
    const direct = tryJson(text);
    if (direct) return direct;
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      const msg = tryJson(data);
      if (msg && ("result" in msg || "error" in msg)) return msg;
    }
    throw new Error(`unreadable MCP response: ${snippet(text)}`);
  }

  /** One JSON-RPC request to /api/mcp. Modern requests carry the 2026-07-28 envelope with clientInfo. */
  async function mcp(method, params, { modern = true } = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    let body = params;
    if (modern) {
      headers["mcp-protocol-version"] = MCP_MODERN;
      headers["mcp-method"] = method;
      if (method === "tools/call") headers["mcp-name"] = params.name;
      body = {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: SMOKE_AGENT, version: "1.0.0" },
        },
      };
    }
    const res = await request("/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: body }),
    });
    if (res.status !== 200) throw new Error(`MCP ${method}: HTTP ${res.status} ${snippet(res.text)}`);
    const msg = mcpMessage(res.text);
    if (msg.error) throw new Error(`MCP ${method}: ${snippet(JSON.stringify(msg.error))}`);
    return msg.result;
  }

  /** A tool call: { value } (structuredContent) or { error } (the ApiError envelope's error). */
  async function callTool(name, args) {
    const result = await mcp("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) return { error: tryJson(text)?.error ?? { code: "unknown", message: text } };
    return { value: result?.structuredContent, text };
  }

  return { request, mcp, callTool };
}

// ---- Status ----

/**
 * Why the deployment can't be smoke-tested yet (empty when it can): /api/status problems, or a commit
 * other than `expectedCommit`.
 */
export function blockedReasons(status, expectedCommit) {
  const reasons = [];
  if (expectedCommit) {
    const have = status?.commit?.toLowerCase();
    if (!have) {
      reasons.push(`The deployment doesn't report its commit, so it can't be matched to ${expectedCommit.slice(0, 7)}.`);
    } else if (!(expectedCommit.startsWith(have) || have.startsWith(expectedCommit))) {
      reasons.push(
        `The deployment is at commit ${have}, not ${expectedCommit.slice(0, 7)}: wait for Vercel to deploy the PR's head commit, then run this again.`,
      );
    }
  }
  if (status?.status !== "ready") {
    const problems = Array.isArray(status?.problems) ? status.problems : [];
    reasons.push(...(problems.length > 0 ? problems : ["/api/status says not_ready without saying why."]));
  }
  return reasons;
}

/** /api/status, or { blocked } when it can't be read. */
async function readStatus(client, { baseUrl, bypass }) {
  let res;
  try {
    res = await client.request("/api/status");
  } catch (err) {
    return { blocked: [`Can't reach ${baseUrl}/api/status: ${errorText(err)}.`] };
  }
  if (isVercelLoginWall(res)) {
    return {
      blocked: [
        bypass
          ? "Vercel refused the bypass secret: check --bypass (or VERCEL_AUTOMATION_BYPASS_SECRET) against Vercel → Settings → Deployment Protection → Protection Bypass for Automation."
          : "preview needs the Vercel bypass secret (--bypass)",
      ],
    };
  }
  if (res.status >= 300 && res.status < 400) {
    return { blocked: [`${baseUrl}/api/status redirects to ${res.headers.get("location")}: run pnpm smoke on that URL instead.`] };
  }
  if (res.status !== 200 || !res.json || typeof res.json.status !== "string") {
    return {
      blocked: [
        `${baseUrl}/api/status answered HTTP ${res.status} ${snippet(res.text, 80)}: this deployment is older than /api/status, or isn't Front Desk.`,
      ],
    };
  }
  return { status: res.json };
}

function describeStatus(s) {
  const db = s.database ?? {};
  const shop = db.shopName ? ` "${db.shopName}"` : "";
  return [
    s.status,
    s.environment,
    `commit ${s.commit ?? "unknown"}`,
    `${db.mode}${shop}`,
    `schema ${db.schema}`,
    db.writesAllowed ? "writes allowed" : "writes not allowed",
    ...(s.alerts ? [`alerts by ${s.alerts}`] : []),
  ].join(" · ");
}

/** The four counts of a nightly tidy-up run (NightlyRun). */
const NIGHTLY_COUNTS = ["expired", "completed", "depositsReleased", "failures"];

/** A NightlyRun as evidence: "ran 2026-11-11T08:00:04Z: expired 0, completed 1, depositsReleased 1, failures 0". */
function describeNightly(run) {
  return `ran ${run.ranAt}: ${NIGHTLY_COUNTS.map((k) => `${k} ${run[k]}`).join(", ")}`;
}

/** Whether `run` looks like a NightlyRun: an RFC 3339 ranAt and four whole counts, none negative. */
function isNightlyRun(run) {
  return (
    run !== null &&
    typeof run === "object" &&
    typeof run.ranAt === "string" &&
    !Number.isNaN(Date.parse(run.ranAt)) &&
    NIGHTLY_COUNTS.every((k) => Number.isInteger(run[k]) && run[k] >= 0)
  );
}

// ---- Checks ----

class CheckFailed extends Error {}

/** Fail the current check with `evidence` unless `ok`. */
function expect(ok, evidence) {
  if (!ok) throw new CheckFailed(evidence);
}

const http = (res) => `HTTP ${res.status} ${snippet(res.text, 100)}`;

/** An RFC 3339 instant in UTC, to the second. */
function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Where feature checks live: one .mjs file per feature (e.g. texting.mjs), each with a default export. */
const SMOKE_CHECKS_DIR = new URL("./smoke-checks/", import.meta.url);

/** Every feature check in scripts/smoke-checks/*.mjs, in file-name order: their default exports. */
export async function loadSmokeChecks(dir = SMOKE_CHECKS_DIR) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort();
  } catch {
    return [];
  }
  const checks = [];
  for (const name of names) {
    const mod = await import(new URL(name, dir).href);
    if (typeof mod.default === "function") checks.push(mod.default);
  }
  return checks;
}

/**
 * Run the smoke test. Prints as it goes through `print`, and returns the verdict, the exit code and the
 * rows. `fetch`, `now`, `random` and `print` are there for tests, and so is `checks` (the feature checks
 * to run; default: loadSmokeChecks()).
 */
export async function runSmoke({
  baseUrl,
  commit,
  bypass,
  ownerToken,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  random = Math.random,
  print = (line) => console.log(line),
  checks,
}) {
  const client = createClient({ baseUrl, bypass, fetchImpl });
  const rows = [];

  print(`pnpm smoke ${baseUrl}${commit ? ` (expecting commit ${commit.slice(0, 7)})` : ""}`);

  // 0. /api/status decides whether anything else runs.
  const read = await readStatus(client, { baseUrl, bypass });
  const reasons = read.blocked ?? blockedReasons(read.status, commit);
  if (read.status) print(`/api/status: ${describeStatus(read.status)}`);
  if (reasons.length > 0) {
    const line = `BLOCKED: ${reasons.join(" ")}`;
    print(line);
    return { verdict: "BLOCKED", exitCode: EXIT.blocked, rows, reasons, line };
  }
  const status = read.status;
  rows.push({
    item: "0",
    title: "/api/status is ready" + (commit ? " at the expected commit" : ""),
    result: "PASS",
    evidence: describeStatus(status),
  });

  /** Run one check and record its row. `run` returns its evidence, or { skipped }. */
  async function check(item, title, run) {
    let row;
    try {
      const out = await run();
      row = out && typeof out === "object" && "skipped" in out
        ? { item, title, result: "SKIPPED", evidence: out.skipped }
        : { item, title, result: "PASS", evidence: String(out ?? "") };
    } catch (err) {
      const evidence = err instanceof CheckFailed ? err.message : `error: ${errorText(err)}`;
      row = { item, title, result: "FAIL", evidence };
    }
    rows.push(row);
    return row;
  }

  // ---- Read-only ----

  await check("2", "/api/health is ok", async () => {
    const res = await client.request("/api/health");
    expect(res.status === 200 && res.json?.status === "ok" && res.json?.service === "emergent", http(res));
    return http(res);
  });

  await check("4", "/api/shops/harts/services: Hart's Barbers, 3 services", async () => {
    const res = await client.request("/api/shops/harts/services");
    const ids = Array.isArray(res.json?.services) ? res.json.services.map((s) => s.id) : null;
    const shop = res.json?.shop;
    expect(res.status === 200 && ids, http(res));
    const evidence = `"${shop?.name}", ${shop?.timezone}, ${ids.join(", ")}`;
    expect(
      typeof shop?.name === "string" &&
        shop.name.startsWith("Hart's Barbers") &&
        shop.timezone === "America/New_York" &&
        JSON.stringify(ids) === JSON.stringify(SHOP_SERVICES),
      evidence,
    );
    return evidence;
  });

  await check("5", "Owner bookings without a token → 401 with the unlock hint", async () => {
    const res = await client.request("/api/shops/harts/bookings");
    const nextAction = res.json?.error?.next_action;
    expect(res.status === 401 && nextAction === UNLOCK_NEXT_ACTION, http(res));
    return `401, next_action "${nextAction}"`;
  });

  const token = ownerToken ?? (status.environment === "preview" ? PREVIEW_OWNER_TOKEN : undefined);
  const tokenLabel = ownerToken ? "the --owner-token" : PREVIEW_OWNER_TOKEN;
  await check("5", `Owner bookings with Bearer ${tokenLabel} → 200`, async () => {
    if (!token) return { skipped: `no owner token for ${status.environment}: pass --owner-token` };
    const res = await client.request("/api/shops/harts/bookings", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status === 200 && Array.isArray(res.json?.bookings), http(res));
    const n = res.json.bookings.length;
    return `200, ${n} booking${n === 1 ? "" : "s"}`;
  });

  await check("5", "Owner alerts without a token → 401 with the unlock hint", async () => {
    const res = await client.request("/api/shops/harts/alerts");
    const nextAction = res.json?.error?.next_action;
    expect(res.status === 401 && nextAction === UNLOCK_NEXT_ACTION, http(res));
    return `401, next_action "${nextAction}"`;
  });

  /** GET /api/shops/harts/alerts with the owner token: the alerts array, or a failed check. */
  async function ownerAlerts() {
    const res = await client.request("/api/shops/harts/alerts", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status === 200 && Array.isArray(res.json?.alerts), http(res));
    return res.json.alerts;
  }
  const describeAlert = (a) => `${a.kind} by ${a.channel}, ${a.status}${a.error ? `: ${a.error}` : ""}`;

  await check("5", `Owner alerts with Bearer ${tokenLabel} → 200`, async () => {
    if (!token) return { skipped: `no owner token for ${status.environment}: pass --owner-token` };
    const alerts = await ownerAlerts();
    return `200, ${alerts.length} alert${alerts.length === 1 ? "" : "s"}${alerts[0] ? ` (newest: ${describeAlert(alerts[0])})` : ""}`;
  });

  await check("6", "/api/shops/nope/services → 404 not_found", async () => {
    const res = await client.request("/api/shops/nope/services");
    expect(res.status === 404 && res.json?.error?.code === "not_found", http(res));
    return `404, code ${res.json.error.code}`;
  });

  await check("7", "GET /api/mcp → 405", async () => {
    const res = await client.request("/api/mcp");
    expect(res.status === 405, http(res));
    return "405";
  });

  await check("7", `MCP initialize as ${SMOKE_AGENT}`, async () => {
    const result = await client.mcp(
      "initialize",
      { protocolVersion: MCP_LEGACY, capabilities: {}, clientInfo: { name: SMOKE_AGENT, version: "1.0.0" } },
      { modern: false },
    );
    expect(result?.serverInfo?.name === "front-desk", `serverInfo ${snippet(JSON.stringify(result?.serverInfo))}`);
    return `server ${result.serverInfo.name} ${result.serverInfo.version}, protocol ${result.protocolVersion}`;
  });

  await check("7", "MCP tools/list has the seven tools", async () => {
    const result = await client.mcp("tools/list", {});
    const names = Array.isArray(result?.tools) ? result.tools.map((t) => t.name).sort() : [];
    expect(JSON.stringify(names) === JSON.stringify(MCP_TOOLS), `tools: ${names.join(", ") || "none"}`);
    return names.join(", ");
  });

  // ---- Web booking API, read-only (docs/web-booking.md) ----

  /** What the web booking checks booked: { slot, booking }. */
  const web = {};

  await check("W1", "Web availability: GET /api/shops/harts/availability?service=haircut", async () => {
    const res = await client.request("/api/shops/harts/availability?service=haircut");
    const days = res.json?.days;
    expect(res.status === 200 && Array.isArray(days), http(res));
    const slots = days.flatMap((d) => (Array.isArray(d?.slots) ? d.slots : []));
    expect(days.length === 7, `${days.length} days, expected 7`);
    const bad = slots.find((s) => typeof s?.start !== "string" || typeof s?.display !== "string");
    expect(!bad, `a slot without start or display: ${snippet(JSON.stringify(bad))}`);
    const n = slots.length;
    return `7 days from ${res.json.from}, ${n} open start${n === 1 ? "" : "s"}${n ? `, first ${slots[0].display}` : ""}`;
  });

  await check("W2", "agents.md says how to book: MCP, then the web API", async () => {
    const res = await client.request("/api/shops/harts/agents.md");
    const type = res.headers.get("content-type") ?? "";
    expect(res.status === 200 && type.startsWith("text/plain"), `HTTP ${res.status} ${type} ${snippet(res.text, 60)}`);
    const needs = [`${baseUrl}/api/mcp`, `${baseUrl}/api/shops/harts/availability`, `${baseUrl}/api/shops/harts/book`, "approval.url"];
    const missing = needs.filter((part) => !res.text.includes(part));
    expect(missing.length === 0, `agents.md doesn't mention ${missing.join(", ")}`);
    return `200 text/plain, ${res.text.length} characters, names the MCP endpoint and the web API on this origin`;
  });

  await check("W3", "/.well-known/front-desk.json points at this deployment", async () => {
    const res = await client.request("/.well-known/front-desk.json");
    const d = res.json;
    expect(res.status === 200 && d, http(res));
    const evidence = `mcp ${d.mcp}, webApi ${d.webApi}, agentsMd ${d.agentsMd}`;
    expect(
      d.mcp === `${baseUrl}/api/mcp` && d.webApi === `${baseUrl}/api/shops/harts` && d.agentsMd === `${baseUrl}/api/shops/harts/agents.md`,
      evidence,
    );
    return evidence;
  });

  // ---- Booking loop (writes) ----

  const depositsOn = status.deposits === "stripe_test";
  const depositsLabel = `deposits ${status.deposits ?? "unknown"}`;
  const loop = [
    ["11", "book a Haircut → awaiting_approval, link on this origin"],
    ["11", "book the same start again → slot_taken"],
    ["12", "get_booking returns the same approval link"],
    ["14", "Decline through /api/approvals/<token>/decline → cancelled"],
    ["14", "The declined start is free again"],
    ["14", "The owner's alerts list has booking_cancelled for it"],
    ["17", "Book a Beard trim (no deposit) and approve it → confirmed"],
    ["17", "The owner's alerts list has booking_confirmed for it"],
    [
      "19",
      depositsOn
        ? `Approve a Haircut (${depositsLabel}) → awaiting_deposit, Stripe Checkout URL`
        : `Approve a Haircut (${depositsLabel}) → confirmed, deposit not_collected`,
    ],
    ["19", depositsOn ? "get_booking: awaiting_deposit, the same approval link" : "get_booking: confirmed, deposit not_collected"],
    ["19", depositsOn ? "cancel it → cancelled, deposit released" : "cancel it → cancelled"],
    ["19", "The cancelled start is free again"],
  ];
  const webLoop = [
    ["W4", "Web book (JSON) → 201 awaiting_approval, link on this origin"],
    ["W4", "The same start as a form post → 303 back with ?error=slot_taken"],
    ["W4", "Decline the web booking → cancelled"],
    ["W5", "Web book (form post) → 303 to /approve/<token>"],
  ];
  const nightly = [
    ["23", "GET /api/jobs/nightly → 200 with its four counts"],
    ["23", "/api/status shows that run as lastNightlyRun"],
  ];

  /** Bookings this run made: { id, token, done, approved } (done: declined or cancelled). */
  const made = [];

  if (!status.database?.writesAllowed) {
    const why =
      status.environment === "production"
        ? "production: never written to"
        : `writes not allowed here (shop "${status.database?.shopName}")`;
    for (const [item, title] of [...loop, ...webLoop, ...nightly]) rows.push({ item, title, result: "SKIPPED", evidence: why });
  } else {
    const ctx = {};
    const needs = (key) => {
      if (!ctx[key]) throw new CheckFailed("not run: an earlier booking check failed");
    };
    const remember = (booking) => {
      const linkToken = booking?.approval?.url?.split("/approve/")[1];
      made.push({ id: booking.id, token: linkToken ? decodeURIComponent(linkToken) : undefined, done: false, approved: false });
    };
    /** Book `service` (a Haircut by default) at a random open start in the next few days: { slot, booking }, or a failed check. */
    const bookOne = async (service = "haircut") => {
      const from = now();
      const avail = await client.callTool("get_availability", {
        service_id: service,
        from: rfc3339(from),
        to: rfc3339(from + BOOKING_WINDOW_DAYS * 24 * 3600_000),
        limit: 50,
      });
      expect(!avail.error, `get_availability: ${snippet(JSON.stringify(avail.error))}`);
      const slots = avail.value?.slots ?? [];
      expect(slots.length > 0, `no open ${service} starts in the next ${BOOKING_WINDOW_DAYS} days`);
      // A random start, so two runs at once rarely pick the same one.
      const slot = slots[Math.floor(random() * slots.length)];
      const booked = await client.callTool("book", { service_id: service, start: slot.start, customer_name: SMOKE_CUSTOMER });
      expect(!booked.error, `book ${slot.start}: ${snippet(JSON.stringify(booked.error))}`);
      const booking = booked.value?.booking;
      if (booking?.id) remember(booking);
      return { slot, booking };
    };
    /** The owner's alert of `kind` for `bookingId`, as evidence; a failed check if it's missing or failed. */
    const alertFor = async (bookingId, kind) => {
      if (!token) return { skipped: `no owner token for ${status.environment}: pass --owner-token` };
      const alerts = await ownerAlerts();
      const alert = alerts.find((a) => a.bookingId === bookingId && a.kind === kind);
      expect(alert, `no ${kind} alert for ${bookingId} among the newest ${alerts.length}`);
      const evidence = describeAlert(alert);
      expect(alert.status === "logged" || alert.status === "sent", evidence);
      return evidence;
    };
    /** A booking known only by its approval link (a form post's 303), so cleanup can decline it. */
    const rememberLink = (location) => {
      const linkToken = location.split("/approve/")[1]?.split(/[?#]/)[0];
      if (linkToken) made.push({ id: undefined, token: decodeURIComponent(linkToken), done: false, approved: false });
    };
    /** Decline one of this run's bookings through its approval link, as the page's Decline button does. */
    const decline = (linkToken) =>
      client.request(`/api/approvals/${encodeURIComponent(linkToken)}/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
    /** A web book request: JSON, or a plain HTML form post from `referer`. */
    const webBook = (fields, { form = false, referer } = {}) =>
      client.request("/api/shops/harts/book", {
        method: "POST",
        headers: form
          ? { "content-type": "application/x-www-form-urlencoded", ...(referer ? { referer } : {}) }
          : { "content-type": "application/json" },
        body: form ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
      });
    /** Open Haircut starts from the web availability route, read now. */
    const webSlots = async () => {
      const res = await client.request("/api/shops/harts/availability?service=haircut");
      expect(res.status === 200 && Array.isArray(res.json?.days), `availability: ${http(res)}`);
      return res.json.days.flatMap((d) => (Array.isArray(d?.slots) ? d.slots : []));
    };
    const webFields = (start) => ({ service: "haircut", start, name: SMOKE_CUSTOMER, bookedBy: SMOKE_AGENT });
    const shortLink = (link) => link.replace(/(\/approve\/.{6}).*/, "$1…");

    try {
      await check(...loop[0], async () => {
        const { slot, booking } = await bookOne();
        const link = booking?.approval?.url ?? "";
        const evidence = `${booking?.display ?? slot.start}: ${booking?.status}, link ${link.replace(/(\/approve\/.{6}).*/, "$1…")}, agent "${booking?.agent?.name}"`;
        expect(booking?.status === "awaiting_approval", evidence);
        expect(link.startsWith(`${baseUrl}/approve/`), `${evidence} (expected a link on ${baseUrl})`);
        expect(booking?.agent?.name === SMOKE_AGENT, `${evidence} (expected agent "${SMOKE_AGENT}")`);
        Object.assign(ctx, { slot, booking, link });
        return evidence;
      });

      await check(...loop[1], async () => {
        needs("booking");
        const again = await client.callTool("book", { service_id: "haircut", start: ctx.slot.start, customer_name: SMOKE_CUSTOMER });
        if (again.value?.booking?.id) remember(again.value.booking);
        expect(again.error?.code === "slot_taken", again.error ? `code ${again.error.code}` : `booked again: ${again.value?.booking?.id}`);
        return `code slot_taken`;
      });

      await check(...loop[2], async () => {
        needs("booking");
        const got = await client.callTool("get_booking", { booking_id: ctx.booking.id });
        expect(!got.error, `get_booking: ${snippet(JSON.stringify(got.error))}`);
        expect(got.value?.booking?.approval?.url === ctx.link, `approval ${snippet(JSON.stringify(got.value?.booking?.approval))}`);
        return `same link, status ${got.value.booking.status}`;
      });

      await check(...loop[3], async () => {
        needs("booking");
        const mine = made.find((b) => b.id === ctx.booking.id);
        expect(mine?.token, "the booking has no approval token");
        const res = await decline(mine.token);
        expect(res.status === 200 && res.json?.booking?.status === "cancelled", http(res));
        mine.done = true;
        ctx.declined = true;
        return "200, status cancelled";
      });

      await check(...loop[4], async () => {
        needs("declined");
        const start = Date.parse(ctx.slot.start);
        const avail = await client.callTool("get_availability", {
          service_id: "haircut",
          from: ctx.slot.start,
          to: rfc3339(start + 3600_000),
        });
        expect(!avail.error, `get_availability: ${snippet(JSON.stringify(avail.error))}`);
        const free = (avail.value?.slots ?? []).some((s) => Date.parse(s.start) === start);
        expect(free, `${ctx.slot.start} isn't in get_availability`);
        return `${ctx.booking.display ?? ctx.slot.start} is back in get_availability`;
      });

      await check(...loop[5], async () => {
        needs("declined");
        return alertFor(ctx.booking.id, "booking_cancelled");
      });

      // A Beard trim has no deposit, so approving confirms it whether or not this deployment collects deposits.
      await check(...loop[6], async () => {
        const { booking } = await bookOne("beard-trim");
        expect(booking?.status === "awaiting_approval", `booked: ${booking?.status}`);
        const mine = made.find((b) => b.id === booking.id);
        expect(mine?.token, "the booking has no approval token");
        const res = await client.request(`/api/approvals/${encodeURIComponent(mine.token)}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status === 200 && res.json?.booking?.status === "confirmed", http(res));
        mine.approved = true;
        ctx.approved = booking;
        return `${booking.display ?? booking.start}: 200, status confirmed`;
      });

      await check(...loop[7], async () => {
        needs("approved");
        return alertFor(ctx.approved.id, "booking_confirmed");
      });

      // ---- Deposits: approve a Haircut. With Stripe it waits for its deposit (never paid here). ----

      await check(...loop[8], async () => {
        const { slot, booking: held } = await bookOne();
        const mine = made.find((b) => b.id === held?.id);
        expect(mine?.token, "the booking has no approval token");
        const res = await client.request(`/api/approvals/${encodeURIComponent(mine.token)}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status === 200, http(res));
        // Approved: cleanup cancels it rather than declining.
        mine.approved = true;
        const approved = res.json?.booking;
        const deposit = approved?.deposit;
        const payUrl = typeof deposit?.payUrl === "string" ? deposit.payUrl : "";
        const evidence =
          `${approved?.display ?? slot.start}: ${approved?.status}, deposit ${deposit?.state}` +
          (payUrl ? `, pay at ${payUrl.slice(0, STRIPE_CHECKOUT.length + 14)}…` : "");
        if (depositsOn) {
          expect(approved?.status === "awaiting_deposit" && deposit?.state === "awaiting_payment", evidence);
          expect(payUrl.startsWith(STRIPE_CHECKOUT), `${evidence} (expected deposit.payUrl on ${STRIPE_CHECKOUT})`);
        } else {
          expect(approved?.status === "confirmed" && deposit?.state === "not_collected", evidence);
        }
        Object.assign(ctx, { depositSlot: slot, depositBooking: approved, depositLink: held.approval?.url });
        return evidence;
      });

      await check(...loop[9], async () => {
        needs("depositBooking");
        const got = await client.callTool("get_booking", { booking_id: ctx.depositBooking.id });
        expect(!got.error, `get_booking: ${snippet(JSON.stringify(got.error))}`);
        const b = got.value?.booking;
        const evidence = `status ${b?.status}, deposit ${b?.deposit?.state}`;
        if (depositsOn) {
          expect(b?.status === "awaiting_deposit" && b?.deposit?.state === "awaiting_payment", evidence);
          expect(b?.approval?.url === ctx.depositLink, `${evidence}, approval ${snippet(JSON.stringify(b?.approval))}`);
          return `${evidence}, the same approval link`;
        }
        expect(b?.status === "confirmed" && b?.deposit?.state === "not_collected", evidence);
        return evidence;
      });

      await check(...loop[10], async () => {
        needs("depositBooking");
        const cancelled = await client.callTool("cancel", { booking_id: ctx.depositBooking.id });
        expect(!cancelled.error, `cancel: ${snippet(JSON.stringify(cancelled.error))}`);
        const b = cancelled.value?.booking;
        const failed = b?.deposit?.actionFailed ? ` (Stripe: ${b.deposit.actionFailed.message})` : "";
        const evidence = `status ${b?.status}, deposit ${b?.deposit?.state}${failed}`;
        expect(b?.status === "cancelled", evidence);
        const mine = made.find((x) => x.id === ctx.depositBooking.id);
        if (mine) mine.done = true;
        ctx.depositCancelled = true;
        if (depositsOn) expect(b?.deposit?.state === "released", evidence);
        return evidence;
      });

      await check(...loop[11], async () => {
        needs("depositCancelled");
        const start = Date.parse(ctx.depositSlot.start);
        const avail = await client.callTool("get_availability", {
          service_id: "haircut",
          from: ctx.depositSlot.start,
          to: rfc3339(start + 3600_000),
        });
        expect(!avail.error, `get_availability: ${snippet(JSON.stringify(avail.error))}`);
        const free = (avail.value?.slots ?? []).some((s) => Date.parse(s.start) === start);
        expect(free, `${ctx.depositSlot.start} isn't in get_availability`);
        return `${ctx.depositBooking.display ?? ctx.depositSlot.start} is back in get_availability`;
      });

      // The web booking API (W4, W5): the same engine, over plain HTTP.
      await check(...webLoop[0], async () => {
        // Read now, not W1's list: the loop above left a confirmed booking until cleanup.
        const pool = await webSlots();
        expect(pool.length > 0, "the web availability has no open Haircut starts");
        const slot = pool[Math.floor(random() * pool.length)];
        const res = await webBook(webFields(slot.start));
        const booking = res.json?.booking;
        if (booking?.id) remember(booking);
        expect(res.status === 201, http(res));
        const link = booking?.approval?.url ?? "";
        const evidence = `${booking?.display ?? slot.start}: ${booking?.status}, link ${shortLink(link)}, agent "${booking?.agent?.name}"`;
        expect(booking?.status === "awaiting_approval", evidence);
        expect(link.startsWith(`${baseUrl}/approve/`), `${evidence} (expected a link on ${baseUrl})`);
        expect(booking?.agent?.name === SMOKE_AGENT, `${evidence} (expected agent "${SMOKE_AGENT}")`);
        Object.assign(web, { slot, booking });
        return evidence;
      });

      await check(...webLoop[1], async () => {
        if (!web.booking) throw new CheckFailed("not run: the web booking check failed");
        const referer = `${baseUrl}/?from=smoke`;
        const res = await webBook(webFields(web.slot.start), { form: true, referer });
        const location = res.headers.get("location") ?? "";
        if (location.includes("/approve/")) rememberLink(location); // a broken server booked it twice
        expect(res.status === 303, http(res));
        const back = new URL(location, baseUrl);
        const evidence = `303 → ${back.pathname}?error=${back.searchParams.get("error")}&message=${snippet(back.searchParams.get("message"), 40)}`;
        expect(back.origin === baseUrl && back.pathname === "/" && back.searchParams.get("from") === "smoke", `${evidence} (expected the Referer, ${referer})`);
        expect(back.searchParams.get("error") === "slot_taken", evidence);
        return evidence;
      });

      await check(...webLoop[2], async () => {
        const mine = made.find((b) => b.id !== undefined && b.id === web.booking?.id);
        if (!mine?.token) throw new CheckFailed("not run: the web booking check failed");
        const res = await decline(mine.token);
        expect(res.status === 200 && res.json?.booking?.status === "cancelled", http(res));
        mine.done = true;
        return "200, status cancelled";
      });

      await check(...webLoop[3], async () => {
        const pool = (await webSlots()).filter((s) => s.start !== web.slot?.start);
        expect(pool.length > 0, "the web availability has no other open Haircut start");
        const slot = pool[Math.floor(random() * pool.length)];
        const res = await webBook(webFields(slot.start), { form: true, referer: `${baseUrl}/` });
        const location = res.headers.get("location") ?? "";
        if (location.includes("/approve/")) rememberLink(location);
        expect(res.status === 303, http(res));
        expect(location.startsWith(`${baseUrl}/approve/`), `303 → ${location || "(no Location)"}`);
        return `${slot.display}: 303 → ${shortLink(location)}`;
      });
    } finally {
      // Decline (or, once approved, cancel) every booking this run made, even after a failure.
      await check("—", "Cleanup: every booking it made is declined or cancelled", async () => {
        const left = [];
        for (const b of made.filter((x) => !x.done)) {
          try {
            if (b.token && !b.approved) {
              const res = await decline(b.token);
              if (res.status === 200) {
                b.done = true;
                continue;
              }
            }
            if (b.id === undefined) {
              // A form post's booking: its approval link is all this run has.
              left.push(`link ${b.token.slice(0, 6)}… (couldn't decline)`);
              continue;
            }
            const cancelled = await client.callTool("cancel", { booking_id: b.id });
            if (!cancelled.error || cancelled.error.code === "not_cancellable") b.done = true;
            else left.push(`${b.id} (${cancelled.error.code})`);
          } catch (err) {
            left.push(`${b.id} (${errorText(err)})`);
          }
        }
        expect(left.length === 0, `still held: ${left.join(", ")}`);
        return `${made.length} made, ${made.length} declined or cancelled: none left behind`;
      });
    }

    // The nightly tidy-up writes (it expires, completes and records its run), so it runs only here too. Its
    // counts depend on what's in the database, so only their shape is checked.
    let nightlyRun;
    await check(...nightly[0], async () => {
      const res = await client.request("/api/jobs/nightly");
      expect(res.status === 200 && isNightlyRun(res.json), `GET /api/jobs/nightly: ${http(res)}`);
      nightlyRun = res.json;
      return describeNightly(nightlyRun);
    });
    await check(...nightly[1], async () => {
      if (!nightlyRun) throw new CheckFailed("not run: GET /api/jobs/nightly failed");
      const res = await client.request("/api/status");
      const last = res.json?.lastNightlyRun;
      // Another run may have finished since (a second smoke run at once): the newest is this one or later.
      expect(
        isNightlyRun(last) && Date.parse(last.ranAt) >= Date.parse(nightlyRun.ranAt),
        `lastNightlyRun: ${snippet(JSON.stringify(last ?? null))}`,
      );
      return describeNightly(last);
    });
  }

  // ---- Feature checks (scripts/smoke-checks/*.mjs) ----

  const featureCtx = { check, client, status, baseUrl, token, now, random, expect, CheckFailed, http, snippet, rfc3339, SMOKE_AGENT, SMOKE_CUSTOMER };
  for (const run of checks ?? (await loadSmokeChecks())) {
    try {
      await run(featureCtx);
    } catch (err) {
      rows.push({ item: "—", title: `Feature check ${run.name || "(unnamed)"}`, result: "FAIL", evidence: `error: ${errorText(err)}` });
    }
  }

  // ---- Report ----

  const titleWidth = Math.min(60, Math.max(...rows.map((r) => r.title.length)));
  print("");
  print(`${"#".padEnd(4)}${"Result".padEnd(9)}${"Check".padEnd(titleWidth)}  Evidence`);
  for (const r of rows) print(`${r.item.padEnd(4)}${r.result.padEnd(9)}${r.title.padEnd(titleWidth)}  ${r.evidence}`);
  print("");

  const count = (result) => rows.filter((r) => r.result === result).length;
  const failed = count("FAIL");
  const skipped = count("SKIPPED");
  const passed = count("PASS");
  const verdict = failed > 0 ? "FAIL" : "PASS";
  const line =
    verdict === "FAIL"
      ? `FAIL: ${failed} failed, ${passed} passed, ${skipped} skipped.`
      : `PASS: ${passed} passed${skipped ? `, ${skipped} skipped (a skipped check is not a pass: verify those by hand)` : ""}.`;
  print(line);
  return { verdict, exitCode: verdict === "FAIL" ? EXIT.fail : EXIT.pass, rows, reasons: [], line };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.error) {
    console.error(options.error);
    process.exit(EXIT.usage);
  }
  const { exitCode } = await runSmoke(options);
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`smoke: ${err?.stack ?? err}`);
    process.exit(EXIT.fail);
  });
}
