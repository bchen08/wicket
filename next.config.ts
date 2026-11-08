import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Agents look for Front Desk at a well-known URL; the route lives under app/api.
  async rewrites() {
    return [{ source: "/.well-known/front-desk.json", destination: "/api/well-known/front-desk" }];
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
