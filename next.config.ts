import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "webdriverio"],
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
    middleware: ["./data/**/*"],
    "next-server": ["./data/**/*"],
    "next-minimal-server": ["./data/**/*"],
  },
};

export default nextConfig;
