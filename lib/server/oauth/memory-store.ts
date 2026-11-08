import { normalizeUuid } from "../frontdesk/booking-store";
import type { AuthorizationCode, Customer, OAuthClient, OAuthToken, SigninStore } from "./store";

// In-memory SigninStore: for `pnpm dev` without DATABASE_URL and for tests. Mirrors the Postgres store's
// rules: one customer per (shop, phone), a code is used at most once.

type StoredCode = AuthorizationCode & { usedAt: Date | null };

const copy = <T extends object>(value: T): T => structuredClone(value);

export function createMemorySigninStore(): SigninStore {
  const customers = new Map<string, Customer>();
  const clients = new Map<string, OAuthClient>();
  const codes = new Map<string, StoredCode>();
  const tokens = new Map<string, OAuthToken>();
  const clientKey = (shopSlug: string, clientId: string) => `${shopSlug}\n${clientId}`;

  return {
    async upsertCustomer(shopSlug, phone, name) {
      const existing = [...customers.values()].find((c) => c.shopSlug === shopSlug && c.phone === phone);
      if (existing) {
        existing.name = name;
        return copy(existing);
      }
      const customer: Customer = { id: crypto.randomUUID(), shopSlug, name, phone };
      customers.set(customer.id, customer);
      return copy(customer);
    },

    async getCustomer(id) {
      const key = normalizeUuid(id);
      const customer = key === null ? undefined : customers.get(key);
      return customer ? copy(customer) : null;
    },

    async getClient(shopSlug, clientId) {
      const client = clients.get(clientKey(shopSlug, clientId));
      return client ? copy(client) : null;
    },

    async saveClient(client) {
      clients.set(clientKey(client.shopSlug, client.clientId), copy(client));
    },

    async createCode(code) {
      codes.set(code.code, { ...copy(code), usedAt: null });
    },

    async useCode(code, now) {
      const stored = codes.get(code);
      if (!stored || stored.usedAt !== null || stored.expiresAt.getTime() <= now.getTime()) return null;
      stored.usedAt = now;
      const { usedAt, ...rest } = stored;
      void usedAt;
      return copy(rest);
    },

    async createTokens(list) {
      for (const t of list) tokens.set(t.token, copy(t));
    },

    async getToken(token, kind) {
      const stored = tokens.get(token);
      if (!stored || stored.kind !== kind) return null;
      const customer = customers.get(stored.customerId);
      return customer ? { token: copy(stored), customer: copy(customer) } : null;
    },
  };
}
