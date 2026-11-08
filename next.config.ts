import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Agents look for Front Desk at well-known URLs; the routes live under app/api.
  async rewrites() {
    return [
      { source: "/.well-known/front-desk.json", destination: "/api/well-known/front-desk" },
      // PAP 0.4 discovery (docs/agent-identity.md).
      { source: "/.well-known/poppy.json", destination: "/api/well-known/poppy" },
      // Connector sign-in (docs/connector-signin.md): RFC 9728 metadata for /api/mcp, with the path inserted and at
      // the root, and RFC 8414 metadata for the issuer.
      { source: "/.well-known/oauth-protected-resource/api/mcp", destination: "/api/oauth/protected-resource" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/protected-resource" },
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata" },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
