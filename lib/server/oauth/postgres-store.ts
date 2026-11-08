import { normalizeUuid } from "../frontdesk/booking-store";
import { getPostgresClient } from "../frontdesk/postgres-store";
import type { AuthorizationCode, Customer, OAuthClient, OAuthToken, SigninCode, SigninStore } from "./store";

// Postgres SigninStore (postgres.js) for supabase/migrations/0008_signin.sql and 0010_signin_codes.sql:
// customers, oauth_clients, oauth_codes, signin_codes and oauth_tokens. Shares the booking store's client
// (one per DATABASE_URL).

type CustomerRow = { id: string; shop_slug: string; name: string; phone: string };

type ClientRow = {
  shop_slug: string;
  client_id: string;
  kind: OAuthClient["kind"];
  client_name: string | null;
  redirect_uris: string[];
  fetched_at: Date;
};

type CodeRow = {
  code: string;
  shop_slug: string;
  client_id: string;
  customer_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string | null;
  expires_at: Date;
};

type SigninCodeRow = {
  id: string;
  shop_slug: string;
  code: string;
  phone: string;
  name: string;
  expires_at: Date;
};

type TokenRow = {
  token: string;
  kind: OAuthToken["kind"];
  shop_slug: string;
  client_id: string;
  customer_id: string;
  scope: string;
  resource: string | null;
  expires_at: Date;
};

const toCustomer = (r: CustomerRow): Customer => ({ id: r.id, shopSlug: r.shop_slug, name: r.name, phone: r.phone });

const toCode = (r: CodeRow): AuthorizationCode => ({
  code: r.code,
  shopSlug: r.shop_slug,
  clientId: r.client_id,
  customerId: r.customer_id,
  redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge,
  scope: r.scope,
  resource: r.resource,
  expiresAt: r.expires_at,
});

const toSigninCode = (r: SigninCodeRow): SigninCode => ({
  id: r.id,
  shopSlug: r.shop_slug,
  code: r.code,
  phone: r.phone,
  name: r.name,
  expiresAt: r.expires_at,
});

const toToken = (r: TokenRow): OAuthToken => ({
  token: r.token,
  kind: r.kind,
  shopSlug: r.shop_slug,
  clientId: r.client_id,
  customerId: r.customer_id,
  scope: r.scope,
  resource: r.resource,
  expiresAt: r.expires_at,
});

export function createPostgresSigninStore(url: string): SigninStore {
  const db = getPostgresClient(url);

  return {
    async upsertCustomer(shopSlug, phone, name) {
      const rows = await db<CustomerRow[]>`
        insert into customers (shop_slug, phone, name) values (${shopSlug}, ${phone}, ${name})
        on conflict (shop_slug, phone) do update set name = excluded.name, updated_at = now()
        returning id::text as id, shop_slug, name, phone
      `;
      if (!rows[0]) throw new Error("Upsert into customers returned no row.");
      return toCustomer(rows[0]);
    },

    async getCustomer(id) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      const rows = await db<CustomerRow[]>`
        select id::text as id, shop_slug, name, phone from customers where id = ${key}::uuid
      `;
      return rows[0] ? toCustomer(rows[0]) : null;
    },

    async getClient(shopSlug, clientId) {
      const rows = await db<ClientRow[]>`
        select shop_slug, client_id, kind, client_name, redirect_uris, fetched_at
        from oauth_clients where shop_slug = ${shopSlug} and client_id = ${clientId}
      `;
      const r = rows[0];
      return r
        ? {
            shopSlug: r.shop_slug,
            clientId: r.client_id,
            kind: r.kind,
            clientName: r.client_name,
            redirectUris: r.redirect_uris,
            fetchedAt: r.fetched_at,
          }
        : null;
    },

    async saveClient(c) {
      await db`
        insert into oauth_clients (shop_slug, client_id, kind, client_name, redirect_uris, fetched_at)
        values (
          ${c.shopSlug}, ${c.clientId}, ${c.kind}, ${c.clientName}, ${db.json(c.redirectUris)}::jsonb,
          ${c.fetchedAt.toISOString()}::timestamptz
        )
        on conflict (shop_slug, client_id) do update set
          kind = excluded.kind, client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
          fetched_at = excluded.fetched_at
      `;
    },

    async createCode(c) {
      await db`
        insert into oauth_codes (
          code, shop_slug, client_id, customer_id, redirect_uri, code_challenge, scope, resource, expires_at
        )
        values (
          ${c.code}, ${c.shopSlug}, ${c.clientId}, ${c.customerId}::uuid, ${c.redirectUri}, ${c.codeChallenge},
          ${c.scope}, ${c.resource}, ${c.expiresAt.toISOString()}::timestamptz
        )
      `;
    },

    async useCode(code, now) {
      // One statement: only an unused, unexpired code is marked used, so it can be exchanged once.
      const rows = await db<CodeRow[]>`
        update oauth_codes set used_at = ${now.toISOString()}::timestamptz
        where code = ${code} and used_at is null and expires_at > ${now.toISOString()}::timestamptz
        returning code, shop_slug, client_id, customer_id::text as customer_id, redirect_uri, code_challenge,
                  scope, resource, expires_at
      `;
      return rows[0] ? toCode(rows[0]) : null;
    },

    async createSigninCode(c) {
      const rows = await db<SigninCodeRow[]>`
        insert into signin_codes (shop_slug, code, phone, name, expires_at)
        values (${c.shopSlug}, ${c.code}, ${c.phone}, ${c.name}, ${c.expiresAt.toISOString()}::timestamptz)
        returning id::text as id, shop_slug, code, phone, name, expires_at
      `;
      if (!rows[0]) throw new Error("Insert into signin_codes returned no row.");
      return toSigninCode(rows[0]);
    },

    async getSigninCode(id, now) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      const rows = await db<SigninCodeRow[]>`
        select id::text as id, shop_slug, code, phone, name, expires_at
        from signin_codes
        where id = ${key}::uuid and used_at is null and expires_at > ${now.toISOString()}::timestamptz
      `;
      return rows[0] ? toSigninCode(rows[0]) : null;
    },

    async useSigninCode(id, code, now) {
      const key = normalizeUuid(id);
      if (key === null) return null;
      // One statement: only the right, unused, unexpired code is marked used, so it can be entered once.
      const rows = await db<SigninCodeRow[]>`
        update signin_codes set used_at = ${now.toISOString()}::timestamptz
        where id = ${key}::uuid and code = ${code} and used_at is null
          and expires_at > ${now.toISOString()}::timestamptz
        returning id::text as id, shop_slug, code, phone, name, expires_at
      `;
      return rows[0] ? toSigninCode(rows[0]) : null;
    },

    async createTokens(tokens) {
      // Together or not at all: an access token without its refresh token would strand the client.
      await db.begin(async (tx) => {
        for (const t of tokens) {
          await tx`
            insert into oauth_tokens (token, kind, shop_slug, client_id, customer_id, scope, resource, expires_at)
            values (
              ${t.token}, ${t.kind}, ${t.shopSlug}, ${t.clientId}, ${t.customerId}::uuid, ${t.scope}, ${t.resource},
              ${t.expiresAt.toISOString()}::timestamptz
            )
          `;
        }
      });
    },

    async getToken(token, kind) {
      const rows = await db<(TokenRow & { customer_shop: string; name: string; phone: string })[]>`
        select t.token, t.kind, t.shop_slug, t.client_id, t.customer_id::text as customer_id, t.scope, t.resource,
               t.expires_at, c.shop_slug as customer_shop, c.name, c.phone
        from oauth_tokens t join customers c on c.id = t.customer_id
        where t.token = ${token} and t.kind = ${kind}
      `;
      const r = rows[0];
      if (!r) return null;
      return {
        token: toToken(r),
        customer: { id: r.customer_id, shopSlug: r.customer_shop, name: r.name, phone: r.phone },
      };
    },
  };
}
