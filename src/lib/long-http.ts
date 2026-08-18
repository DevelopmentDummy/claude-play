import * as http from "http";
import * as https from "https";

/**
 * 장시간(수십 분) 응답을 기다리는 로컬 HTTP 요청 헬퍼.
 *
 * ⚠️ 전역 fetch(undici)를 쓰면 안 되는 이유:
 *    undici의 headersTimeout 기본값은 300초이고, `AbortSignal`로 준 타임아웃은
 *    이 값을 **연장하지 못한다**. 응답 헤더를 렌더 완료 시점에야 보내는 블로킹
 *    엔드포인트(GPU Manager `/comfyui/generate`, 브릿지 `/api/tools/comfyui/generate`)를
 *    호출하면 아무리 큰 timeoutMs를 줘도 정확히 약 305초에
 *    `TypeError: fetch failed (UND_ERR_HEADERS_TIMEOUT)`로 끊긴다.
 *    영상 워크플로 한 판은 12~40분이므로 fetch 경로로는 구조적으로 완주할 수 없다.
 *    node:http는 이 절벽이 없고 소켓 유휴 타임아웃만 걸리므로 여기서만 사용한다.
 */
export interface LongRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** JSON 직렬화된 본문 문자열 */
  body?: string;
  /** 소켓 유휴 타임아웃(ms). 이 시간 동안 아무 바이트도 오가지 않으면 끊는다. */
  timeoutMs?: number;
}

export interface LongResponse {
  status: number;
  ok: boolean;
  text: string;
}

export function longRequest(url: string, options: LongRequestOptions = {}): Promise<LongResponse> {
  const { method = "GET", headers = {}, body, timeoutMs = 3_900_000 } = options;
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise<LongResponse>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );

    // 유휴(무통신) 타임아웃 — 렌더 중에는 서버가 아무것도 보내지 않으므로
    // 렌더 예산과 같은 크기로 잡아야 한다.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`));
    });
    req.on("error", reject);

    if (body !== undefined) req.write(body);
    req.end();
  });
}
