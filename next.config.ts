import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["handlebars", "ws", "node-edge-tts"],
  // 동적 require 탓에 file tracer가 data/ 전체(수백만 파일)를 추적해 빌드가 분 단위로
  // 느려진다 — 사용자 데이터는 배포 산출물이 아니므로 통째로 제외 (2026-07-12).
  // 주의: Next 15부터 top-level 옵션. experimental 아래 두면 조용히 무시됨.
  outputFileTracingExcludes: {
    "*": ["./data/**/*", "./scratch/**/*"],
  },
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
    middlewareClientMaxBodySize: "50mb",
    // 서버 컴파일·트레이스 단계 병렬화 (2026-07-12)
    parallelServerCompiles: true,
    parallelServerBuildTraces: true,
  },
};

export default nextConfig;
