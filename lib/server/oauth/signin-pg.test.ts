import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../clock";
import { closePostgresClients, createPostgresStore, getPostgresClient } from "../frontdesk/postgres-store";
import { book } from "../frontdesk/service";
import { recordingNotifier, TEST_BASE_URL, withBaseUrl } from "../frontdesk/test-support";
import { listMyBookings } from "../identity/customer";
import { createPostgresSigninStore } from "./postgres-store";

// Connector sign-in's store against a real Postgres (migration 0008_signin.sql), when DATABASE_URL_TEST
// points at a migrated, seeded database (see docs/database.md): customers by (shop, phone), clients, a code
// used once, tokens with their customer, and bookings that record customer_id. Like flow-pg.test.ts it makes
// a throwaway shop, books only in 2099, and deletes everything it made in afterAll.
const url = process.env.DATABASE_URL_TEST?.trim();

if (!url) {
  describe("Connector sign-in on Postgres", () => {
    it.skip("skipped: set DATABASE_URL_TEST to a migrated, seeded Postgres to run the sign-in store against a real database", () => {});
  });
} else {
  describe("Connector sign-in on Postgres (DATABASE_URL_TEST)", () => {
    const sql = getPostgresClient(url);
    const signin = createPostgresSigninStore(url);
    const store = createPostgresStore(url);
    const run = Math.random().toString(16).slice(2, 10);
    const shop = `vitest-signin-${run}`;
    const staffId = `vitest-signin-${run}-sam`;
    const zone = "America/New_York";
    /** 6 digits of this run's own, in every phone number this file uses. */
    const prefix = String(100000 + Math.floor(Math.random() * 900000));
    const phone = (n: number) => `+1${prefix}${String(1000 + n)}`;

    let now = new Date();
    const clock: Clock = { now: () => new Date(now.getTime()) };
    const deps = withBaseUrl({ catalog: store, store, clock, notifier: recordingNotifier(), baseUrl: TEST_BASE_URL });
    const tuesday = DateTime.fromObject({ year: 2099, month: 3, day: 3 }, { zone })
      .plus({ weeks: Math.floor(Math.random() * 30) })
      .set({ weekday: 2 })
      .startOf("day");
    const at = (days: number, hh: number) => tuesday.plus({ days }).set({ hour: hh }).toISO({ suppressMilliseconds: true })!;

    beforeAll(async () => {
      await sql`insert into shops (slug, name, timezone) values (${shop}, 'Vitest Signin Shop', ${zone})`;
      await sql`insert into staff (id, shop_slug, name) values (${staffId}, ${shop}, 'Sam')`;
      await sql`
        insert into weekly_hours (staff_id, weekday, opens, closes)
        select ${staffId}, day, time '09:00', time '17:00' from generate_series(2, 6) as day
      `;
      await sql`
        insert into services (shop_slug, id, name, duration_min, price_cents, deposit_cents, position)
        values (${shop}, 'trim', 'Trim', 30, 2000, 0, 1)
      `;
      await sql`
        insert into policies (shop_slug, lead_time_min, horizon_days, deposit_horizon_days, cancel_window_hours, paused)
        values (${shop}, 0, 30, 6, 24, false)
      `;
    });

    afterAll(async () => {
      await sql`delete from bookings where shop_slug = ${shop}`;
      await sql`delete from oauth_tokens where shop_slug = ${shop}`;
      await sql`delete from oauth_codes where shop_slug = ${shop}`;
      await sql`delete from signin_codes where shop_slug = ${shop}`;
      await sql`delete from oauth_clients where shop_slug = ${shop}`;
      await sql`delete from customers where shop_slug = ${shop}`;
      await sql`delete from shops where slug = ${shop}`;
      await closePostgresClients();
    });

    it("finds a customer by (shop, phone), keeping the newest name", async () => {
      const first = await signin.upsertCustomer(shop, phone(1), "Maya");
      const again = await signin.upsertCustomer(shop, phone(1), "Maya Lopez");
      expect(again).toEqual({ ...first, name: "Maya Lopez" });
      expect(await signin.getCustomer(first.id)).toEqual(again);
      expect(await signin.getCustomer("not-a-uuid")).toBeNull();
      const other = await signin.upsertCustomer(shop, phone(2), "Lee");
      expect(other.id).not.toBe(first.id);
    });

    it("keeps a texted code until the right one is entered, once, and only in time", async () => {
      const at = new Date("2026-11-09T17:00:00Z");
      const expiresAt = new Date(at.getTime() + 600_000);
      const input = { shopSlug: shop, code: "042917", phone: phone(4), name: "Texted Person", expiresAt };
      const stored = await signin.createSigninCode(input);
      expect(stored).toEqual({ ...input, id: expect.any(String) });

      expect(await signin.getSigninCode(stored.id, at)).toEqual(stored);
      expect(await signin.getSigninCode("not-a-uuid", at)).toBeNull();
      expect(await signin.getSigninCode(stored.id, expiresAt)).toBeNull();

      expect(await signin.useSigninCode(stored.id, "111111", at)).toBeNull();
      expect(await signin.useSigninCode("not-a-uuid", "042917", at)).toBeNull();
      expect(await signin.useSigninCode(stored.id, "042917", expiresAt)).toBeNull();

      // Still good after those: of two at once, one gets it, and then it's gone.
      const [a, b] = await Promise.all([signin.useSigninCode(stored.id, "042917", at), signin.useSigninCode(stored.id, "042917", at)]);
      expect([a, b].filter(Boolean)).toEqual([stored]);
      expect(await signin.useSigninCode(stored.id, "042917", at)).toBeNull();
      expect(await signin.getSigninCode(stored.id, at)).toBeNull();
    });

    it("stores clients, a code that can be used once, and tokens with their customer", async () => {
      const fetchedAt = new Date("2026-11-09T17:00:00Z");
      const client = {
        shopSlug: shop,
        clientId: "https://client.example/oauth/client.json",
        kind: "cimd" as const,
        clientName: "Test Agent",
        redirectUris: ["https://client.example/callback"],
        fetchedAt,
      };
      await signin.saveClient(client);
      await signin.saveClient({ ...client, clientName: "Renamed" });
      expect(await signin.getClient(shop, client.clientId)).toEqual({ ...client, clientName: "Renamed" });
      expect(await signin.getClient(shop, "nobody")).toBeNull();

      const customer = await signin.upsertCustomer(shop, phone(3), "Code Person");
      const code = {
        code: `fdc_${run}`,
        shopSlug: shop,
        clientId: client.clientId,
        customerId: customer.id,
        redirectUri: "https://client.example/callback",
        codeChallenge: "challenge",
        scope: "bookings",
        resource: null,
        expiresAt: new Date(Date.now() + 600_000),
      };
      await signin.createCode(code);
      const [a, b] = await Promise.all([signin.useCode(code.code, new Date()), signin.useCode(code.code, new Date())]);
      expect([a, b].filter(Boolean)).toEqual([code]);
      expect(await signin.useCode(code.code, new Date())).toBeNull();
      await signin.createCode({ ...code, code: `fdc_${run}_late`, expiresAt: new Date(Date.now() - 1) });
      expect(await signin.useCode(`fdc_${run}_late`, new Date())).toBeNull();

      const expiresAt = new Date("2099-01-01T00:00:00Z");
      const token = { shopSlug: shop, clientId: client.clientId, customerId: customer.id, scope: "bookings", resource: "https://x.test/api/mcp", expiresAt };
      await signin.createTokens([
        { ...token, token: `fda_${run}`, kind: "access" },
        { ...token, token: `fdr_${run}`, kind: "refresh" },
      ]);
      expect(await signin.getToken(`fda_${run}`, "access")).toEqual({
        token: { ...token, token: `fda_${run}`, kind: "access" },
        customer,
      });
      expect(await signin.getToken(`fda_${run}`, "refresh")).toBeNull();
      expect(await signin.getToken(`fdr_${run}`, "refresh")).toMatchObject({ customer: { id: customer.id } });
    });

    it("records customer_id and the phone on a signed-in booking, and lists only that customer's", async () => {
      now = new Date(at(-1, 12));
      const maya = await signin.upsertCustomer(shop, phone(4), "Maya Booker");
      const lee = await signin.upsertCustomer(shop, phone(5), "Lee Booker");
      const mine = await book(deps, shop, { service_id: "trim", start: at(0, 10), customer_name: maya.name, customer_phone: maya.phone }, "vitest", maya);
      expect(mine.booking.customer).toMatchObject({ displayName: "Maya Booker", phone: maya.phone });
      await book(deps, shop, { service_id: "trim", start: at(0, 11), customer_name: lee.name }, "vitest", lee);
      await book(deps, shop, { service_id: "trim", start: at(0, 12), customer_name: "Anonymous" }, "vitest");
      const later = await book(deps, shop, { service_id: "trim", start: at(1, 9), customer_name: "Maya B" }, "vitest", maya);

      const [row] = await sql<{ customer_id: string }[]>`select customer_id::text as customer_id from bookings where id = ${mine.booking.id}::uuid`;
      expect(row.customer_id).toBe(maya.id);

      const listed = await listMyBookings(deps, shop, maya);
      expect(listed.bookings.map((b) => b.id)).toEqual([mine.booking.id, later.booking.id]);
      expect(listed.bookings[0].approval?.url).toMatch(/^http:\/\/localhost:3000\/approve\//);
      expect((await store.listCustomerBookings(shop, maya.id, new Date(at(0, 11)), 1)).map((b) => b.id)).toEqual([later.booking.id]);
      expect(await store.listCustomerBookings(shop, "not-a-uuid", new Date(0), 10)).toEqual([]);
    });
  });
}
