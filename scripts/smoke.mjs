#!/usr/bin/env node
// pnpm smoke <base-url> [--commit <sha>] [--bypass <secret>] [--owner-token <token>]
//
// Runs every API check in SMOKE.md against one deployment and prints PASS / FAIL / SKIPPED with evidence,
// then one verdict line. Node 20+ and nothing else: no dependencies, no repo code imported.
//
// 1. Reads /api/status first. If the deployment isn't ready, or isn't at --commit, it prints
//    "BLOCKED: <problems>", runs nothing else and exits 2. BLOCKED means the environment isn't ready,
//    not that the code is wrong.
// 2. Read-only checks: health, services, owner access, errors, the MCP route.
// 3. The booking loop, only where /api/status says writesAllowed (the Preview database, or in-memory
//    data): book → slot_taken → get_booking → decline → the slot is free again. Every booking it makes
//    is declined at the end, even after a failure. Its MCP requests say they come from
//    "front-desk-smoke", so the bookings show who made them.
//
// --bypass <secret> (or VERCEL_AUTOMATION_BYPASS_SECRET) sends Vercel's x-vercel-protection-bypass header
// on every request, for previews behind Vercel Authentication. --owner-token overrides the owner token,
// which is harts-preview on previews; elsewhere the owner 200 check is SKIPPED without it.
//
// Exit codes: 0 every check passed (some may be SKIPPED), 1 a check failed, 2 BLOCKED, 64 bad arguments.

import { pathToFileURL } from "node:url";

export const SMOKE_AGENT = "front-desk-smoke";
export const SMOKE_CUSTOMER = "Smoke Test";
/** The Preview environment's OWNER_API_TOKEN. Not a secret: production's value is different and private. */
export const PREVIEW_OWNER_TOKEN = "harts-preview";
export const UNLOCK_NEXT_ACTION = "Open /console/unlock and enter the shop's access code.";
export const BYPASS_HEADER = "x-vercel-protection-bypass";
export const EXIT = { pass: 0, fail: 1, blocked: 2, usage: 64 };

const SHOP_SERVICES = ["haircut", "beard-trim", "haircut-beard"];
const MCP_TOOLS = ["book", "cancel", "get_availability", "get_booking", "get_policies", "list_services"];
/** Tool calls use the 2026-07-28 protocol, whose per-request _meta envelope carries clientInfo (the agent's name). */
const MCP_MODERN = "2026-07-28";
const MCP_LEGACY = "2025-06-18";
const REQUEST_TIMEOUT_MS = 15_000;
/** Haircut takes a deposit, and Hart's books those up to 6 days ahead. */
const BOOKING_WINDOW_DAYS = 6;

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
  ].join(" · ");
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

/**
 * Run the smoke test. Prints as it goes through `print`, and returns the verdict, the exit code and the
 * rows. `fetch`, `now`, `random` and `print` are there for tests.
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

  await check("7", "MCP tools/list has the six tools", async () => {
    const result = await client.mcp("tools/list", {});
    const names = Array.isArray(result?.tools) ? result.tools.map((t) => t.name).sort() : [];
    expect(JSON.stringify(names) === JSON.stringify(MCP_TOOLS), `tools: ${names.join(", ") || "none"}`);
    return names.join(", ");
  });

  // ---- Booking loop (writes) ----

  const loop = [
    ["11", "book a Haircut → awaiting_approval, link on this origin"],
    ["11", "book the same start again → slot_taken"],
    ["12", "get_booking returns the same approval link"],
    ["14", "Decline through /api/approvals/<token>/decline → cancelled"],
    ["14", "The declined start is free again"],
  ];
  /** Bookings this run made: { id, token, done } (done: declined or cancelled). */
  const made = [];

  if (!status.database?.writesAllowed) {
    const why =
      status.environment === "production"
        ? "production: never written to"
        : `writes not allowed here (shop "${status.database?.shopName}")`;
    for (const [item, title] of loop) rows.push({ item, title, result: "SKIPPED", evidence: why });
  } else {
    const ctx = {};
    const needs = (key) => {
      if (!ctx[key]) throw new CheckFailed("not run: an earlier booking check failed");
    };
    const remember = (booking) => {
      const linkToken = booking?.approval?.url?.split("/approve/")[1];
      made.push({ id: booking.id, token: linkToken ? decodeURIComponent(linkToken) : undefined, done: false });
    };

    try {
      await check(...loop[0], async () => {
        const from = now();
        const avail = await client.callTool("get_availability", {
          service_id: "haircut",
          from: rfc3339(from),
          to: rfc3339(from + BOOKING_WINDOW_DAYS * 24 * 3600_000),
          limit: 50,
        });
        expect(!avail.error, `get_availability: ${snippet(JSON.stringify(avail.error))}`);
        const slots = avail.value?.slots ?? [];
        expect(slots.length > 0, `no open Haircut starts in the next ${BOOKING_WINDOW_DAYS} days`);
        // A random start, so two runs at once rarely pick the same one.
        const slot = slots[Math.floor(random() * slots.length)];
        const booked = await client.callTool("book", { service_id: "haircut", start: slot.start, customer_name: SMOKE_CUSTOMER });
        expect(!booked.error, `book ${slot.start}: ${snippet(JSON.stringify(booked.error))}`);
        const booking = booked.value?.booking;
        if (booking?.id) remember(booking);
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
        const res = await client.request(`/api/approvals/${encodeURIComponent(mine.token)}/decline`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
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
    } finally {
      // Decline every booking this run made, even after a failure.
      await check("—", "Cleanup: every booking it made is declined", async () => {
        const left = [];
        for (const b of made.filter((x) => !x.done)) {
          try {
            if (b.token) {
              const res = await client.request(`/api/approvals/${encodeURIComponent(b.token)}/decline`, {
                method: "POST",
                headers: { "content-type": "application/json" },
              });
              if (res.status === 200) {
                b.done = true;
                continue;
              }
            }
            const cancelled = await client.callTool("cancel", { booking_id: b.id });
            if (!cancelled.error || cancelled.error.code === "not_cancellable") b.done = true;
            else left.push(`${b.id} (${cancelled.error.code})`);
          } catch (err) {
            left.push(`${b.id} (${errorText(err)})`);
          }
        }
        expect(left.length === 0, `still held: ${left.join(", ")}`);
        return `${made.length} made, ${made.length} declined: none left behind`;
      });
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
