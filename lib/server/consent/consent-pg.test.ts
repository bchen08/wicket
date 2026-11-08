import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Booking } from "../../types/frontdesk";
import type { Clock } from "../clock";
import { FrontDeskError } from "../frontdesk/errors";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "../frontdesk/postgres-store";
import { book, getAvailability, getBooking } from "../frontdesk/service";
import { approvalToken, lastSentCode, recordingNotifier, TEST_CONSENT, withConsent } from "../frontdesk/test-support";
import { approveBooking, declineBooking, getApprovalView, sendApprovalCode } from "./approvals";

// Ring 1b's consent flow against a real Postgres, through the approval use cases (what the
// /api/approvals/[token]/* routes call) and book, when DATABASE_URL_TEST points at a database with
// 0001, 0002, 0003 and the seed applied (see docs/database.md). Like flow-pg.test.ts it never touches
// Hart's: a throwaway shop (one staff member, Tue–Sat 09:00–17:00, a 30-minute service with a deposit),
// bookings only in 2099, each test in its own week, and everything deleted in afterAll. Phone numbers
// carry a 6-digit prefix of this run's own, so its customers and send limits never meet another run's.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Consent flow on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the consent flow against a real database", () => {});
  });
} else {
  describe("Consent flow on Postgres (DATABASE_URL_TEST)", () => {
    const store = createPostgresStore(url);
    const sql = getPostgresClient(url);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-consent-${run}`;
    const staffId = `vitest-consent-${run}-sam`;
    const zone = "America/New_York";
    /** 6 digits of this run's own, in every phone number this file uses. */
    const PHONE_PREFIX = String(100000 + Math.floor(Math.random() * 900000));

    /** A clock the tests move. */
    let now = new Date();
    const clock: Clock = { now: () => new Date(now.getTime()) };
    const notifier = recordingNotifier();
    const deps = withConsent({ catalog: store, store, clock, notifier, consent: TEST_CONSENT });

    /** Every idempotency key this file uses, deleted in afterAll. */
    const keys: string[] = [];
    const newKey = () => {
      const k = crypto.randomUUID();
      keys.push(k);
      return k;
    };

    // A random Tuesday in 2099; each test books in its own week after it.
    const firstTuesday = DateTime.fromObject({ year: 2099, month: 1, day: 6 }, { zone })
      .plus({ weeks: Math.floor(Math.random() * 30) })
      .set({ weekday: 2 })
      .startOf("day");
    /** `hh:mm` on Tuesday (+ `dayOffset` days) of week `week`, as an RFC 3339 string in New York. */
    const time = (week: number, dayOffset: number, hh: number, mm = 0) =>
      firstTuesday.plus({ weeks: week, days: dayOffset }).set({ hour: hh, minute: mm }).toISO({ suppressMilliseconds: true })!;
    const setNow = (iso: string) => {
      now = new Date(iso);
    };

    const hold = async (start: string, customer = "Consent Test"): Promise<Booking> =>
      (await book(deps, shop, { service_id: "trim", start, customer_name: customer, idempotency_key: newKey() }, "vitest consent"))
        .booking;
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => {
          throw new Error("expected a FrontDeskError");
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(FrontDeskError);
          return err as FrontDeskError;
        },
      );
    const eventsOf = async (id: string) => (await store.listEvents(id)).map((e) => [e.type, e.actor]);
    /** A phone number of this run's own, e.g. phone(7) = "+1<prefix>0007". */
    const phone = (n: number) => `+1${PHONE_PREFIX}${String(n).padStart(4, "0")}`;
    /** A code that isn't `code`. */
    const wrong = (code: string) => code.slice(0, 5) + String((Number(code[5]) + 1) % 10);

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Consent Shop', ${zone})`;
      await sql`insert into staff (id, shop_slug, name) values (${staffId}, ${shop}, 'Sam')`;
      await sql`
        insert into weekly_hours (staff_id, weekday, opens, closes)
        select ${staffId}, day, time '09:00', time '17:00' from generate_series(2, 6) as day
      `;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 500, 1)
      `;
      await sql`
        insert into policies (
          shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused, phone,
          deposit_rule, late_cancel_rule, no_show_rule
        ) values (${shop}, 120, 30, 6, 24, false, '+1 555-0100', 'Held at booking.', 'Inside 24 hours we keep it.', 'We keep it.')
      `;
    });

    afterAll(async () => {
      if (keys.length > 0) await sql`delete from idempotency_keys where key = any(${keys}::text[])`;
      // Customers aren't cascaded from bookings; approvals and codes are.
      await sql`delete from customers where id in (select customer_id from bookings where shop_slug = ${shop})`;
      await sql`delete from bookings where shop_slug = ${shop}`;
      await sql`delete from shops where slug = ${shop}`; // staff, hours, services and policies cascade
      await closePostgresClients();
    });

    it("the approve path: code → approve → confirmed with a verified customer; nothing raw stored; owner alerted once", async () => {
      setNow(time(0, 0, 9));
      const alertsBefore = notifier.alerts.length;
      const booking = await hold(time(0, 1, 10), "Maya Lopez");
      expect(booking.status).toBe("awaiting_approval");
      const token = approvalToken(booking);
      expect(await getApprovalView(deps, token)).toMatchObject({
        status: "pending",
        shop: { slug: shop },
        serviceName: "Trim",
        priceCents: 2000,
        depositCents: 500,
        customerName: "Maya Lopez",
        agentName: "vitest consent",
        expiresAt: time(0, 0, 9, 10),
      });

      // Typed with separators, as a person might: stored normalized.
      const sent = await sendApprovalCode(deps, token, { phone: `+1 ${PHONE_PREFIX.slice(0, 3)}-${PHONE_PREFIX.slice(3)}-0123` });
      expect(sent).toEqual({ sentTo: "0123", expiresAt: time(0, 0, 9, 10) }); // no devCode: dev codes are off
      expect((await getApprovalView(deps, token)).codeSentTo).toBe("0123");
      const code = lastSentCode(deps);

      const { booking: approved } = await approveBooking(deps, token, { code });
      expect(approved).toEqual({
        ...booking,
        approval: undefined,
        status: "confirmed",
        customer: { displayName: "Maya Lopez", verified: true, phoneLast4: "0123" },
      });
      expect(approved).not.toHaveProperty("approval");
      expect((await getBooking(deps, shop, { booking_id: booking.id })).booking).toEqual(approved);
      expect((await getApprovalView(deps, token)).status).toBe("approved");

      // Stored: the phone as plain E.164, the code only as its hash.
      const [customer] = await sql<{ id: string; phone: string; display_name: string }[]>`
        select c.id::text as id, c.phone, c.display_name
        from customers c join bookings b on b.customer_id = c.id where b.id = ${booking.id}::uuid
      `;
      expect(customer).toMatchObject({ phone: phone(123), display_name: "Maya Lopez" });
      const challenges = await sql<{ json: string; attempts: number; consumed_at: Date | null }[]>`
        select row_to_json(o)::text as json, attempts, consumed_at from otp_challenges o where booking_id = ${booking.id}::uuid
      `;
      expect(challenges).toHaveLength(1);
      expect(challenges[0]).toMatchObject({ attempts: 1, consumed_at: new Date(time(0, 0, 9)) });
      expect(challenges[0].json).toContain(phone(123));
      expect(challenges[0].json).not.toContain(`"${code}"`);
      const [approval] = await sql<{ decision: string; decided_at: Date; token_hash: string }[]>`
        select decision, decided_at, token_hash from approvals where booking_id = ${booking.id}::uuid
      `;
      expect(approval).toMatchObject({ decision: "approved", decided_at: new Date(time(0, 0, 9)) });
      expect(approval.token_hash).not.toBe(token);

      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["approved", "customer"],
      ]);
      expect(notifier.alerts.slice(alertsBefore).map((b) => [b.id, b.status])).toEqual([[booking.id, "confirmed"]]);

      // The same code again, or any answer now: approval_closed, and the owner isn't told twice.
      expect((await failure(approveBooking(deps, token, { code }))).code).toBe("approval_closed");
      expect((await failure(declineBooking(deps, token))).code).toBe("approval_closed");
      expect(notifier.alerts.length - alertsBefore).toBe(1);
    });

    it("lazy expiry: a lapsed hold doesn't block a new book for its slot; it becomes expired with exactly one event", async () => {
      setNow(time(1, 0, 9));
      const start = time(1, 1, 11);
      const stale = await hold(start);
      setNow(time(1, 0, 9, 10)); // the deadline

      const next = await hold(start, "Next Person");
      expect(next).toMatchObject({ start, status: "awaiting_approval" });
      // book expired the stale hold in its own transaction.
      expect((await store.getBooking(stale.id))?.status).toBe("expired");
      expect(await eventsOf(stale.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      // Reading it, and its approval page, expire nothing more; the link is closed.
      expect((await getBooking(deps, shop, { booking_id: stale.id })).booking.status).toBe("expired");
      expect((await getApprovalView(deps, approvalToken(stale))).status).toBe("expired");
      expect((await failure(sendApprovalCode(deps, approvalToken(stale), { phone: phone(1) }))).code).toBe("approval_expired");
      expect(await store.listEvents(stale.id)).toHaveLength(2);
    });

    it("lazy expiry on read: opening the approval page of a lapsed hold expires that booking once", async () => {
      setNow(time(2, 0, 9));
      const booking = await hold(time(2, 1, 12));
      setNow(time(2, 0, 9, 11));
      const token = approvalToken(booking);
      expect((await getApprovalView(deps, token)).status).toBe("expired");
      expect((await getApprovalView(deps, token)).status).toBe("expired");
      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
      expect((await failure(approveBooking(deps, token, { code: "123456" }))).code).toBe("approval_expired");
    });

    it("two agents racing for a lapsed hold's slot: one new hold, one slot_taken, and the old hold expires once", async () => {
      setNow(time(3, 0, 9));
      const start = time(3, 1, 13);
      const stale = await hold(start);
      setNow(time(3, 0, 10));
      const results = await Promise.allSettled([hold(start, "Agent A's person"), hold(start, "Agent B's person")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      expect(reason).toMatchObject({ code: "slot_taken" });
      expect(await eventsOf(stale.id)).toEqual([
        ["booked", "agent"],
        ["expired", "system"],
      ]);
    });

    it("decline → cancelled by the customer, the slot freed, no owner alert", async () => {
      setNow(time(4, 0, 9));
      const alertsBefore = notifier.alerts.length;
      const start = time(4, 1, 14);
      const booking = await hold(start);
      const { booking: declined } = await declineBooking(deps, approvalToken(booking));
      expect(declined).toMatchObject({ id: booking.id, status: "cancelled", customer: { verified: false } });
      const [row] = await sql<{ cancelled_by: string; decision: string }[]>`
        select b.cancelled_by, a.decision from bookings b join approvals a on a.booking_id = b.id where b.id = ${booking.id}::uuid
      `;
      expect(row).toEqual({ cancelled_by: "customer", decision: "declined" });
      expect(await eventsOf(booking.id)).toEqual([
        ["booked", "agent"],
        ["declined", "customer"],
      ]);
      const wednesday = { service_id: "trim", from: time(4, 1, 0), to: time(4, 2, 0), limit: 50 };
      expect((await getAvailability(deps, shop, wednesday)).slots.map((s) => s.start)).toContain(start);
      expect(await hold(start, "Someone Else")).toMatchObject({ status: "awaiting_approval" });
      expect(notifier.alerts.length - alertsBefore).toBe(0);
    });

    it("wrong code ×5 → too_many_attempts (attempts 5), even for the right code after; a new code works", async () => {
      setNow(time(5, 0, 9));
      const booking = await hold(time(5, 1, 10));
      const token = approvalToken(booking);
      await sendApprovalCode(deps, token, { phone: phone(50) });
      const code = lastSentCode(deps);
      for (let left = 4; left >= 1; left--) {
        const err = await failure(approveBooking(deps, token, { code: wrong(code) }));
        expect(err.code).toBe("code_invalid");
        expect(err.details).toEqual({ attemptsLeft: left });
      }
      expect((await failure(approveBooking(deps, token, { code: wrong(code) }))).code).toBe("too_many_attempts");
      const [row] = await sql<{ attempts: number }[]>`
        select attempts from otp_challenges where booking_id = ${booking.id}::uuid order by id desc limit 1
      `;
      expect(row.attempts).toBe(5);
      expect((await failure(approveBooking(deps, token, { code }))).code).toBe("too_many_attempts");
      expect((await getApprovalView(deps, token)).codeSentTo).toBeUndefined();

      await sendApprovalCode(deps, token, { phone: phone(50) });
      expect((await approveBooking(deps, token, { code: lastSentCode(deps) })).booking.status).toBe("confirmed");
    });

    it("an expired code → code_expired; a code that was replaced by a newer one no longer works", async () => {
      setNow(time(6, 0, 9));
      const booking = await hold(time(6, 1, 10));
      const token = approvalToken(booking);
      await sendApprovalCode(deps, token, { phone: phone(60) });
      const first = lastSentCode(deps);
      await sql`
        update otp_challenges set expires_at = ${new Date(now.getTime() - 1000).toISOString()}::timestamptz
        where booking_id = ${booking.id}::uuid
      `;
      expect((await failure(approveBooking(deps, token, { code: first }))).code).toBe("code_expired");

      await sendApprovalCode(deps, token, { phone: phone(60) });
      const second = lastSentCode(deps);
      if (second !== first) {
        expect((await failure(approveBooking(deps, token, { code: first }))).code).toBe("code_invalid");
      }
      expect((await approveBooking(deps, token, { code: second })).booking.status).toBe("confirmed");
    });

    it("send limits: 3 codes per phone per hour (retryAfter in seconds), 10 per link", async () => {
      setNow(time(7, 0, 9));
      const a = approvalToken(await hold(time(7, 1, 10)));
      for (let i = 0; i < 3; i++) await sendApprovalCode(deps, a, { phone: phone(70) });
      const limited = await failure(sendApprovalCode(deps, a, { phone: phone(70) }));
      expect(limited.code).toBe("rate_limited");
      expect(limited.details).toEqual({ retryAfter: 3600, limit: "phone" }); // the clock hasn't moved: a full hour
      // Another number still gets a code for the same link.
      expect((await sendApprovalCode(deps, a, { phone: phone(71) })).sentTo).toBe("0071");

      const b = approvalToken(await hold(time(7, 1, 11)));
      for (let i = 0; i < 10; i++) await sendApprovalCode(deps, b, { phone: phone(100 + i) });
      const linkLimited = await failure(sendApprovalCode(deps, b, { phone: phone(120) }));
      expect(linkLimited.code).toBe("rate_limited");
      expect(linkLimited.details).toMatchObject({ limit: "link", retryAfter: 3600 });

      // An hour later the first phone's sends no longer count (with a new hold: the others have lapsed).
      setNow(time(7, 0, 10));
      const c = approvalToken(await hold(time(7, 1, 12)));
      expect((await sendApprovalCode(deps, c, { phone: phone(70) })).sentTo).toBe("0070");
    });

    it("concurrent sends to one phone across links can't exceed the per-phone limit", async () => {
      setNow(time(8, 0, 9));
      const tokens = [
        approvalToken(await hold(time(8, 1, 10))),
        approvalToken(await hold(time(8, 1, 11))),
        approvalToken(await hold(time(8, 1, 12))),
      ];
      const results = await Promise.allSettled(
        [...tokens, ...tokens].map((token) => sendApprovalCode(deps, token, { phone: phone(80) })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected.map((r) => (r.reason as FrontDeskError).code)).toEqual(["rate_limited", "rate_limited", "rate_limited"]);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from otp_challenges where phone = ${phone(80)}
      `;
      expect(n).toBe(3);
    });
  });
}
