import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["handlebars", "ws", "node-edge-tts"],
  devIndicators: false,
};

export default nextConfig;
