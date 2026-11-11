import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second build (e.g. one pointed at a QA contract with NEXT_PUBLIC_CONTRACT_ID) can live
  // beside the main one: NEXT_DIST_DIR=.next-qa.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Basic hardening for every path, "/" included: headers match the requested path before
  // the rewrite, so the static landing (/seed/index.html behind "/") gets them too. Only
  // frame-ancestors in the CSP: a script policy would break the inline scripts and wallets.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // The wallet modules (viem, wagmi, WalletConnect) make a big client bundle; build it with
  // less memory so it also fits on a busy machine.
  experimental: { webpackMemoryOptimizations: true, cpus: 1 },
  // Old addresses go to their current place.
  async redirects() {
    return [
      { source: "/classic", destination: "/", permanent: false },
      // old pages: hatching and Mind pages now live inside the game; the redesign drafts are gone
      { source: "/hatch", destination: "/app?hatch=1", permanent: false },
      { source: "/mind/:id", destination: "/app?tab=account", permanent: false },
      { source: "/designs/:path*", destination: "/", permanent: false },
      { source: "/new", destination: "/", permanent: false },
      { source: "/v1", destination: "/", permanent: false },
    ];
  },
  // The landing is the static page in public/seed.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/seed/index.html" }], afterFiles: [], fallback: [] };
  },
  // Some wallet modules (lib/wallets.ts) carry Node-only code paths they never take in a
  // browser: near-snap's file keystore wants `fs`, WalletConnect's logger optionally wants
  // `pino-pretty`. Stub them out of the client bundle.
  webpack(config, { isServer }) {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, os: false };
    }
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

export default nextConfig;
