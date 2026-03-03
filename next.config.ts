import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow server-side fs/child_process in API routes
  serverExternalPackages: ["handlebars"],
};

export default nextConfig;
