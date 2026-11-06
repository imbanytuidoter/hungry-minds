import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second build (e.g. one pointed at a QA contract with NEXT_PUBLIC_CONTRACT_ID) can live
  // beside the main one: NEXT_DIST_DIR=.next-qa.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The wallet modules (viem, wagmi, WalletConnect) make a big client bundle; build it with
  // less memory so it also fits on a busy machine.
  experimental: { webpackMemoryOptimizations: true, cpus: 1 },
  // /classic was the first landing (sample art from lib/sample-minds.json); it is replaced
  // by / and must not show sample Minds as if they were live.
  async redirects() {
    return [{ source: "/classic", destination: "/", permanent: false }];
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
