// Data access for connector sign-in: customers, OAuth clients, authorization codes and tokens.
// Implementations: postgres-store.ts (migration 0008_signin.sql) and memory-store.ts (local dev, tests).
// Everything is stored as it is (MVP rule: no hashing). Every record carries its shop.

/** A person signed in at a shop: one per (shop, phone). */
export type Customer = {
  id: string;
  shopSlug: string;
  /** The latest name they signed in with, 1–80 characters. */
  name: string;
  /** E.164. Not verified yet. TODO(ring-2): a texted code. */
  phone: string;
};

/** A client Front Desk knows: a cached Client ID Metadata Document, or a dynamically registered client. */
export type OAuthClient = {
  shopSlug: string;
  /** cimd: the HTTPS URL of the metadata document. registered: the id Front Desk issued. */
  clientId: string;
  kind: "cimd" | "registered";
  clientName: string | null;
  redirectUris: string[];
  /** When the document was fetched (cimd) or the client registered. */
  fetchedAt: Date;
};

/** One sign-in, waiting to be exchanged for tokens at the token endpoint. */
export type AuthorizationCode = {
  code: string;
  shopSlug: string;
  clientId: string;
  customerId: string;
  redirectUri: string;
  /** base64url(SHA-256(code_verifier)). */
  codeChallenge: string;
  scope: string;
  resource: string | null;
  expiresAt: Date;
};

/** An access token (1 hour) or a refresh token (30 days). */
export type OAuthToken = {
  token: string;
  kind: "access" | "refresh";
  shopSlug: string;
  clientId: string;
  customerId: string;
  scope: string;
  resource: string | null;
  expiresAt: Date;
};

export interface SigninStore {
  /**
   * The shop's customer with this phone, created if there is none. An existing customer's name becomes
   * `name` (the latest name they signed in with).
   */
  upsertCustomer(shopSlug: string, phone: string, name: string): Promise<Customer>;
  /** A customer by id, or null. Any string is accepted: a malformed id is simply not found. */
  getCustomer(id: string): Promise<Customer | null>;

  /** A client the shop knows, or null. */
  getClient(shopSlug: string, clientId: string): Promise<OAuthClient | null>;
  /** Store a client, replacing any with the same (shop, client id). */
  saveClient(client: OAuthClient): Promise<void>;

  /** Store a new authorization code. */
  createCode(code: AuthorizationCode): Promise<void>;
  /**
   * Use a code, once: mark it used and return it, atomically, only if it exists, wasn't used and hasn't
   * expired at `now`. Otherwise null. Of two concurrent calls, at most one gets the code.
   */
  useCode(code: string, now: Date): Promise<AuthorizationCode | null>;

  /** Store new tokens. */
  createTokens(tokens: OAuthToken[]): Promise<void>;
  /**
   * The token of this kind, with its customer, if it exists. Expired tokens are returned too (the caller
   * decides what an expired token means); null if there is no such token or its customer is gone.
   */
  getToken(token: string, kind: OAuthToken["kind"]): Promise<{ token: OAuthToken; customer: Customer } | null>;
}
