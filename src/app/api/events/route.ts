import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  const { sse } = getServices();

  let clientController: ReadableStreamDefaultController | null = null;
  const stream = new ReadableStream({
    start(controller) {
      clientController = controller;
      sse.addClient(controller);
    },
    cancel() {
      if (clientController) {
        sse.removeClient(clientController);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
