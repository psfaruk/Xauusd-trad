import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // audit P2.1/P2.2: strict mode was off and build errors were ignored —
  // both hid real defects (double-effect bugs reached production; type
  // errors accumulated silently for releases). The repo now type-checks
  // clean as a gate (CI runs tsc --noEmit) instead of opting out of it.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
};

export default nextConfig;
