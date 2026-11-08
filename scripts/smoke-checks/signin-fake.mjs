// A stand-in for Front Desk's connector sign-in routes, for the smoke script's tests (scripts/smoke.test.mjs
// and scripts/smoke-checks/signin.test.mjs). Not a test file itself. It answers the discovery documents, the
// OAuth endpoints and the signed-in MCP calls; anything else (anonymous MCP calls but list_my_bookings, the rest
// of the API) is left to the caller's fake (handle returns undefined).

import { createHash } from "node:crypto";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A fake sign-in server on `baseUrl`. `breaks` turns one behavior off to make a check fail:
 * "metadata" (the issuer is wrong), "challenge" (anonymous list_my_bookings answers 200), "name" (a signed-in
 * book keeps the agent's missing name as "unknown").
 */
export function fakeSigninServer({ baseUrl, breaks = null }) {
  const state = { clients: new Map(), codes: new Map(), tokens: new Map(), bookings: [], customer: null };
  let n = 0;

  const toolResult = (structuredContent) => ({ content: [{ type: "text", text: "ok" }], structuredContent });
  const rpc = (id, result) => json({ jsonrpc: "2.0", id, result });

  /** Answer the request, or undefined to leave it to the caller's fake. */
  async function handle(url, init, headers) {
    const method = init.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && path === "/.well-known/oauth-protected-resource/api/mcp") {
      return json({ resource: `${baseUrl}/api/mcp`, authorization_servers: [breaks === "metadata" ? "https://elsewhere.example" : baseUrl] });
    }
    if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
        token_endpoint: `${baseUrl}/api/oauth/token`,
        registration_endpoint: `${baseUrl}/api/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (method === "POST" && path === "/api/oauth/register") {
      const body = JSON.parse(init.body);
      const clientId = `fd_client_${++n}`;
      state.clients.set(clientId, { name: body.client_name, redirectUris: body.redirect_uris });
      return json({ client_id: clientId, redirect_uris: body.redirect_uris }, 201);
    }
    if (method === "GET" && path === "/api/oauth/authorize") {
      const client = state.clients.get(url.searchParams.get("client_id"));
      if (!client || !client.redirectUris.includes(url.searchParams.get("redirect_uri"))) {
        return new Response("Front Desk can't sign you in.\n\nUnknown client_id.", { status: 400 });
      }
      return new Response(null, { status: 302, headers: { location: `${baseUrl}/signin?${url.searchParams}` } });
    }
    if (method === "GET" && path === "/signin") {
      const client = state.clients.get(url.searchParams.get("client_id"));
      return new Response(`<h1>${client?.name ?? "?"} wants to book for you</h1>`, { headers: { "content-type": "text/html" } });
    }
    if (method === "POST" && path === "/api/oauth/authorize") {
      const form = new URLSearchParams(init.body);
      const code = `fdc_${++n}`;
      state.customer = { name: form.get("name"), phone: form.get("phone").replace(/\s/g, "") };
      state.codes.set(code, { challenge: form.get("code_challenge"), clientId: form.get("client_id") });
      const back = new URL(form.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", form.get("state"));
      back.searchParams.set("iss", baseUrl);
      return new Response(null, { status: 303, headers: { location: back.toString() } });
    }
    if (method === "POST" && path === "/api/oauth/token") {
      const form = new URLSearchParams(init.body);
      const issue = () => {
        const access = `fda_${++n}`;
        state.tokens.set(access, true);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: `fdr_${n}`, scope: "bookings" });
      };
      if (form.get("grant_type") === "refresh_token") return form.get("refresh_token")?.startsWith("fdr_") ? issue() : json({ error: "invalid_grant" }, 400);
      const code = state.codes.get(form.get("code"));
      state.codes.delete(form.get("code"));
      const verified = code && createHash("sha256").update(form.get("code_verifier")).digest("base64url") === code.challenge;
      return verified ? issue() : json({ error: "invalid_grant" }, 400);
    }
    if (method === "POST" && path === "/api/mcp") {
      const message = JSON.parse(init.body);
      const name = message.params?.name;
      const token = headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token) {
        if (name !== "list_my_bookings" || breaks === "challenge") return undefined;
        return json(
          { error: "invalid_token" },
          401,
          { "www-authenticate": `Bearer error="invalid_token", scope="bookings", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/mcp"` },
        );
      }
      if (!state.tokens.has(token)) return json({ error: "invalid_token" }, 401);
      const args = message.params.arguments ?? {};
      if (name === "book") {
        const booking = {
          id: `signed-in-${++n}`,
          status: "awaiting_approval",
          start: args.start,
          customer: { displayName: args.customer_name ?? (breaks === "name" ? "unknown" : state.customer.name), approved: false, phone: state.customer.phone },
        };
        state.bookings.push(booking);
        return rpc(message.id, toolResult({ booking }));
      }
      if (name === "list_my_bookings") {
        return rpc(message.id, toolResult({ customer: state.customer, bookings: state.bookings, truncated: false }));
      }
      if (name === "cancel") {
        const booking = state.bookings.find((b) => b.id === args.booking_id);
        booking.status = "cancelled";
        return rpc(message.id, toolResult({ booking, depositEffect: "none", depositCollected: false }));
      }
      return undefined;
    }
    return undefined;
  }

  return { handle, state };
}
