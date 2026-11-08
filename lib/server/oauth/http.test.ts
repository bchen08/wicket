import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClientRegistrationResponse, ListMyBookingsResult, TokenResponse } from "../../types/oauth";
import { getFrontDeskDeps } from "../frontdesk/deps";
import { createFrontDeskMcpHandler } from "../frontdesk/mcp";
import { withCustomerSignin } from "../identity/customer";
import { authorizeGet, authorizePost, corsPreflight, registerPost, tokenPost } from "./http";
import { s256 } from "./token";

// The OAuth routes as HTTP, the way a connector drives them: register (JSON), authorize (302 to /signin),
// the /signin form (303 back with a code), the token endpoint (form-encoded), then /api/mcp with the
// token. Runs on the app's own deps: the in-memory stores (no DATABASE_URL in tests) and the real clock.

const ORIGIN = "http://localhost:3000";
const CALLBACK = "https://agent.example/oauth/callback";

describe("OAuth over HTTP", () => {
  it("register → authorize → sign in → token → list_my_bookings", async () => {
    const reg = await registerPost(
      new Request(`${ORIGIN}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTTP Agent", redirect_uris: [CALLBACK] }),
      }),
    );
    expect(reg.status).toBe(201);
    expect(reg.headers.get("access-control-allow-origin")).toBe("*");
    const client = (await reg.json()) as ClientRegistrationResponse;

    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      state: "s1",
      resource: `${ORIGIN}/api/mcp`,
    });
    const start = await authorizeGet(new Request(`${ORIGIN}/api/oauth/authorize?${query}`));
    expect(start.status).toBe(302);
    const signin = new URL(start.headers.get("location")!);
    expect(signin.pathname).toBe("/signin");

    // The /signin form posts the parameters back with the person's answer.
    const form = new URLSearchParams(signin.searchParams);
    form.set("name", "Http Person");
    form.set("phone", "+1 212 555 0100");
    form.set("decision", "allow");
    const answer = await authorizePost(
      new Request(`${ORIGIN}/api/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      }),
    );
    expect(answer.status).toBe(303);
    const back = new URL(answer.headers.get("location")!);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);

    const tokenRes = await tokenPost(
      new Request(`${ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: back.searchParams.get("code")!,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: CALLBACK,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokens = (await tokenRes.json()) as TokenResponse;

    const mcp = withCustomerSignin(createFrontDeskMcpHandler(() => getFrontDeskDeps()));
    const res = await mcp(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_my_bookings", arguments: {} } }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
    const result = JSON.parse(json).result as { structuredContent: ListMyBookingsResult };
    expect(result.structuredContent.customer).toEqual({ name: "Http Person", phone: "+12125550100" });
  });

  it("answers a bad token request as an OAuth error, and CORS preflights", async () => {
    const res = await tokenPost(
      new Request(`${ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=nope&code_verifier=x",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(corsPreflight().status).toBe(204);
  });

  it("shows an unknown client as a page instead of redirecting", async () => {
    const res = await authorizeGet(
      new Request(`${ORIGIN}/api/oauth/authorize?response_type=code&client_id=nobody&redirect_uri=${encodeURIComponent(CALLBACK)}`),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toMatch(/Unknown client_id/);
  });
});
