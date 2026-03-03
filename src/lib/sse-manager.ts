const encoder = new TextEncoder();

export class SSEManager {
  private controllers = new Set<ReadableStreamDefaultController>();

  addClient(controller: ReadableStreamDefaultController): void {
    this.controllers.add(controller);
  }

  removeClient(controller: ReadableStreamDefaultController): void {
    this.controllers.delete(controller);
  }

  broadcast(event: string, data: unknown): void {
    const payload = encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    );
    for (const c of this.controllers) {
      try {
        c.enqueue(payload);
      } catch {
        this.controllers.delete(c);
      }
    }
  }

  get clientCount(): number {
    return this.controllers.size;
  }
}
