import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["playwright-core"],
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
    middleware: ["./data/**/*"],
    "next-server": ["./data/**/*"],
    "next-minimal-server": ["./data/**/*"],
  },
};

export default nextConfig;
