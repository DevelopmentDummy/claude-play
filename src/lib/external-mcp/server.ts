import type { IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EXTERNAL_TOOLS } from "./registry";
import { validateExternalToken } from "./token";

/**
 * /mcp/external — 외부 에이전트용 Streamable HTTP MCP 엔드포인트 (stateless).
 * 요청마다 McpServer + transport를 새로 만들어 처리 후 폐기하므로 세션 상태가 없다.
 * server.ts가 Next.js 핸들러보다 먼저 이 함수로 라우팅한다 (ADMIN 미들웨어 미적용 경로).
 */
function buildExternalMcpServer(): McpServer {
  const server = new McpServer({ name: "claude-play-external", version: "0.1.0" });
  for (const tool of EXTERNAL_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (input: Record<string, unknown>) => {
        try {
          const result = await tool.handler(input);
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
        }
      }
    );
  }
  return server;
}

export async function handleExternalMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  if (!validateExternalToken(req.headers["x-external-token"])) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized: missing or invalid x-external-token" }));
    return;
  }
  if (req.method !== "POST") {
    // stateless 모드 — GET(SSE 스트림)/DELETE(세션 종료)는 지원하지 않는다
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. This endpoint is stateless (POST only)." },
        id: null,
      })
    );
    return;
  }

  const server = buildExternalMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
