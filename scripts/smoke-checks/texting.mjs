// pnpm smoke feature checks: texting (SMOKE.md → Texting, docs/texting.md). Loaded by scripts/smoke.mjs.
//
// T1  /api/status says how texts go: photon, twilio or off (everywhere; read-only).
// T2  POST /api/owner/code where texting is off → 400 invalid_request, details.reason texting_off. Where
//     texting is on it's SKIPPED: it would text the owner (T5 is the by-hand check).
// T3  POST /api/owner/session with a made-up code → 401 and no cookie (everywhere; writes nothing).
// T4  Where writes are allowed and texting is off: MCP book with customer_phone → texted false, the phone
//     stored on the booking; then it's declined. Where texting is on it's SKIPPED (it would text a number).

const SMOKE_PHONE = "+12125550123";
const BOOKING_WINDOW_DAYS = 6;
const MODES = ["photon", "twilio", "off"];

/** @param {any} ctx the feature-check context from runSmoke */
export default async function texting(ctx) {
  const { check, client, status, now, random, expect, CheckFailed, http, snippet, rfc3339, SMOKE_CUSTOMER } = ctx;
  const mode = status.texting;
  const on = mode === "photon" || mode === "twilio";

  await check("T1", "/api/status says how texts go (photon, twilio or off)", async () => {
    expect(MODES.includes(mode), `texting: ${JSON.stringify(mode)} (expected one of ${MODES.join(", ")}; is the deployment older than texting?)`);
    return `texting ${mode}`;
  });

  await check("T2", "POST /api/owner/code with texting off → 400 texting_off", async () => {
    if (on) return { skipped: `texting is ${mode}: sending a code texts the owner; check T5 by hand` };
    const res = await client.request("/api/owner/code", { method: "POST" });
    const error = res.json?.error;
    expect(res.status === 400 && error?.code === "invalid_request" && error?.details?.reason === "texting_off", http(res));
    return `400 invalid_request, reason texting_off: "${snippet(error.next_action, 60)}"`;
  });

  await check("T3", "POST /api/owner/session with a made-up code → 401, no cookie", async () => {
    const res = await client.request("/api/owner/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status === 401 && res.json?.error?.code === "unauthorized", http(res));
    expect(!res.headers.get("set-cookie"), `401 but it set a cookie: ${snippet(res.headers.get("set-cookie"), 40)}`);
    return `401 unauthorized: "${snippet(res.json.error.message, 60)}"`;
  });

  await check("T4", "MCP book with customer_phone (texting off) → texted false, phone stored", async () => {
    if (!status.database?.writesAllowed) return { skipped: status.environment === "production" ? "production: never written to" : "writes not allowed here" };
    if (on) return { skipped: `texting is ${mode}: booking with a phone would text it; check T6 by hand` };
    const from = now();
    const avail = await client.callTool("get_availability", {
      service_id: "beard-trim",
      from: rfc3339(from),
      to: rfc3339(from + BOOKING_WINDOW_DAYS * 24 * 3600_000),
      limit: 50,
    });
    expect(!avail.error, `get_availability: ${snippet(JSON.stringify(avail.error))}`);
    const slots = avail.value?.slots ?? [];
    expect(slots.length > 0, `no open beard-trim starts in the next ${BOOKING_WINDOW_DAYS} days`);
    const slot = slots[Math.floor(random() * slots.length)];
    const booked = await client.callTool("book", {
      service_id: "beard-trim",
      start: slot.start,
      customer_name: SMOKE_CUSTOMER,
      customer_phone: SMOKE_PHONE,
    });
    expect(!booked.error, `book ${slot.start}: ${snippet(JSON.stringify(booked.error))}`);
    const booking = booked.value?.booking;
    const linkToken = booking?.approval?.url?.split("/approve/")[1];
    const evidence = `texted ${booked.value?.texted}, customer.phone ${booking?.customer?.phone}`;
    const ok = booked.value?.texted === false && booking?.customer?.phone === SMOKE_PHONE;
    // Decline it whatever it says, as the page's Decline button does.
    if (!linkToken) throw new CheckFailed(`book returned no approval link (${evidence}): ${snippet(JSON.stringify(booking))}`);
    const declined = await client.request(`/api/approvals/${linkToken}/decline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(ok, `${evidence}${declined.status === 200 ? " (declined)" : ` (and couldn't decline ${booking.id}: ${http(declined)})`}`);
    expect(declined.status === 200, `couldn't decline ${booking.id}: ${http(declined)}`);
    return `${slot.display ?? slot.start}: ${evidence}; declined`;
  });
}
