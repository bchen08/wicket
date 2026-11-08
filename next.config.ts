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
