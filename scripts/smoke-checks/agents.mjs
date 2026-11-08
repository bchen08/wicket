// pnpm smoke feature checks: agent identity (SMOKE.md → Agent identity, docs/agent-identity.md). Loaded by
// scripts/smoke.mjs.
//
// A1–A2 are read-only and run everywhere. A3–A6 book, so like the booking loop they run only where
// /api/status says writesAllowed, and every booking they make is declined at the end, even after a failure.
// A3 books as the demo PAP agent (scripts/demo-pap-agent.mjs) with a new key each run, named
// "front-desk-smoke (PAP)"; A6 books over plain MCP as front-desk-smoke, as Claude or ChatGPT do.

import { bookAsPapAgent, createIdentity } from "../demo-pap-agent.mjs";

/** The PAP agent smoke books as. */
export const SMOKE_PAP_AGENT = "front-desk-smoke (PAP)";

export const AGENT_READ_CHECKS = [
  ["A1", "/.well-known/poppy.json: PAP 0.4 for this host, pointing at the MCP endpoint"],
  ["A2", "MCP with an invalid Poppy-Session → 400 invalid_session"],
];
export const AGENT_WRITE_CHECKS = [
  ["A3", "The demo PAP agent books a Beard trim → agent confirmed, with its name"],
  ["A4", "The owner's bookings list shows that booking's agent confirmed"],
  ["A5", "The owner's agents list has the agent, with its booking and last seen"],
  ["A6", "MCP without Poppy-Session books as before → agent unconfirmed"],
];

/** @param {any} ctx the feature-check context from runSmoke */
export default async function agents(ctx) {
  const { check, client, baseUrl, expect, http } = ctx;
  const host = new URL(baseUrl).host;

  await check(...AGENT_READ_CHECKS[0], async () => {
    const res = await client.request("/.well-known/poppy.json");
    const doc = res.json;
    expect(res.status === 200 && doc, http(res));
    const mcp = Array.isArray(doc.apis) ? doc.apis.find((a) => a?.type === "mcp") : undefined;
    const evidence = `PAP ${doc.protocol_version}, "${doc.organization?.name}" on ${doc.organization?.domain}, mcp ${mcp?.url}`;
    expect(doc.protocol_version === "0.4" && doc.organization?.domain === host && mcp?.url === `${baseUrl}/api/mcp`, evidence);
    const fd = await client.request("/.well-known/front-desk.json");
    expect(fd.json?.poppy === `${baseUrl}/.well-known/poppy.json`, `${evidence}; front-desk.json poppy ${fd.json?.poppy}`);
    return `${evidence}; listed in front-desk.json`;
  });

  await check(...AGENT_READ_CHECKS[1], async () => {
    const res = await client.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "poppy-session": "not-a-session-jwt",
        "poppy-version": "0.4",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status === 400 && res.json?.error === "invalid_session", http(res));
    return `400, error invalid_session ("${String(res.json.error_description ?? "").slice(0, 60)}")`;
  });

  if (!ctx.status.database?.writesAllowed) {
    const why =
      ctx.status.environment === "production" ? "production: never written to" : `writes not allowed here (shop "${ctx.status.database?.shopName}")`;
    for (const [item, title] of AGENT_WRITE_CHECKS) await check(item, title, async () => ({ skipped: why }));
    return;
  }

  const noToken = { skipped: `no owner token for ${ctx.status.environment}: pass --owner-token` };
  const owner = (path) => client.request(path, { headers: { authorization: `Bearer ${ctx.token}` } });
  /** Bookings these checks made: { id, link }. */
  const made = [];
  const remember = (booking) => booking?.id && made.push({ id: booking.id, link: booking.approval?.url });
  const pap = {};

  try {
    await check(...AGENT_WRITE_CHECKS[0], async () => {
      const identity = await createIdentity({ name: SMOKE_PAP_AGENT });
      const { booking } = await bookAsPapAgent({
        baseUrl,
        identity,
        customer: "Smoke Test",
        fetch: ctx.fetch,
        bypass: ctx.bypass,
        now: ctx.now,
        random: ctx.random,
      });
      remember(booking);
      const agent = booking?.agent ?? {};
      const evidence = `${booking?.display}: ${booking?.status}, agent "${agent.name}" ${agent.confirmed ? "confirmed" : "unconfirmed"}`;
      expect(booking?.serviceId === "beard-trim" && booking?.status === "awaiting_approval", evidence);
      expect(agent.confirmed === true && agent.name === SMOKE_PAP_AGENT && agent.clientId === identity.clientId, evidence);
      Object.assign(pap, { booking, identity });
      return evidence;
    });

    await check(...AGENT_WRITE_CHECKS[1], async () => {
      if (!ctx.token) return noToken;
      expect(pap.booking, "not run: the PAP booking check failed");
      const res = await owner("/api/shops/harts/bookings");
      expect(res.status === 200 && Array.isArray(res.json?.bookings), http(res));
      const listed = res.json.bookings.find((b) => b.id === pap.booking.id);
      expect(listed, `booking ${pap.booking.id} isn't in the owner's list`);
      const evidence = `agent "${listed.agent?.name}", confirmed ${listed.agent?.confirmed}`;
      expect(listed.agent?.confirmed === true && listed.agent?.name === SMOKE_PAP_AGENT, evidence);
      return evidence;
    });

    await check(...AGENT_WRITE_CHECKS[2], async () => {
      if (!ctx.token) return noToken;
      expect(pap.identity, "not run: the PAP booking check failed");
      const res = await owner("/api/shops/harts/agents");
      expect(res.status === 200 && Array.isArray(res.json?.agents), http(res));
      const agent = res.json.agents.find((a) => a.clientId === pap.identity.clientId);
      expect(agent, `the agent isn't among the ${res.json.agents.length} listed`);
      const evidence = `"${agent.name}": ${agent.bookings} booking${agent.bookings === 1 ? "" : "s"}, last seen ${agent.lastSeen}; ${res.json.agents.length} agents, ${res.json.unconfirmedBookings} unconfirmed bookings`;
      expect(agent.name === SMOKE_PAP_AGENT && agent.bookings === 1 && typeof agent.lastSeen === "string", evidence);
      return evidence;
    });

    await check(...AGENT_WRITE_CHECKS[3], async () => {
      const from = ctx.now();
      const avail = await client.callTool("get_availability", {
        service_id: "beard-trim",
        from: new Date(from).toISOString(),
        to: new Date(from + 6 * 24 * 3600_000).toISOString(),
        limit: 50,
      });
      expect(!avail.error, `get_availability: ${JSON.stringify(avail.error)}`);
      const slots = (avail.value?.slots ?? []).filter((s) => s.start !== pap.booking?.start);
      expect(slots.length > 0, "no other open Beard trim start in the next 6 days");
      const slot = slots[Math.floor(ctx.random() * slots.length)];
      const booked = await client.callTool("book", { service_id: "beard-trim", start: slot.start, customer_name: "Smoke Test" });
      expect(!booked.error, `book ${slot.start}: ${JSON.stringify(booked.error)}`);
      const booking = booked.value?.booking;
      remember(booking);
      const evidence = `agent "${booking?.agent?.name}", confirmed ${booking?.agent?.confirmed}`;
      expect(booking?.agent?.confirmed === false && booking.agent.name === ctx.SMOKE_AGENT && !("clientId" in booking.agent), evidence);
      return evidence;
    });
  } finally {
    await check("—", "Cleanup: the agent checks' bookings are declined", async () => {
      const left = [];
      for (const b of made) {
        const token = b.link?.split("/approve/")[1];
        const res = token
          ? await client.request(`/api/approvals/${token}/decline`, { method: "POST", headers: { "content-type": "application/json" } })
          : null;
        if (res?.status !== 200) left.push(b.id);
      }
      expect(left.length === 0, `still held: ${left.join(", ")}`);
      return `${made.length} made, ${made.length} declined`;
    });
  }
}
