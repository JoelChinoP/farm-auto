import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";

process.env.FARM_AUTO_RUNTIME_ID ||= randomUUID();

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
