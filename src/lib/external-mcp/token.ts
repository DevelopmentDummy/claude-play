import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "@/lib/data-dir";

/**
 * 외부 MCP 엔드포인트(/mcp/external)용 고정 토큰.
 * data/.runtime/external-mcp-token에 영속화 — 서버와 setup-external.mjs가 같은 파일을 공유한다.
 */
export function getExternalTokenPath(): string {
  return path.join(getDataDir(), ".runtime", "external-mcp-token");
}

export function getExternalToken(): string {
  const file = getExternalTokenPath();
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {
    /* 없으면 아래에서 생성 */
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", "utf-8");
  return token;
}

/** x-external-token 헤더 검증 (timing-safe). 배열/누락 헤더는 거부. */
export function validateExternalToken(header: string | string[] | undefined): boolean {
  if (typeof header !== "string" || !header) return false;
  const expected = getExternalToken();
  const a = crypto.createHash("sha256").update(header).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
