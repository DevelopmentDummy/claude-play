// src/lib/gpu-queue.ts

const GPU_QUEUE_KEY = "__claude_bridge_gpu_queue__";

interface QueueItem {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  label: string;
}

class GpuQueue {
  private queue: QueueItem[] = [];
  private running = false;

  async enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        label,
      });
      this.process();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.running;
  }

  private async process(): Promise<void> {
    if (this.running) return;
    const item = this.queue.shift();
    if (!item) return;

    this.running = true;
    console.log(`[gpu-queue] Starting: ${item.label} (${this.queue.length} queued)`);
    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.running = false;
      console.log(`[gpu-queue] Done: ${item.label}`);
      this.process();
    }
  }
}

export function getGpuQueue(): GpuQueue {
  const g = globalThis as unknown as Record<string, GpuQueue>;
  if (!g[GPU_QUEUE_KEY]) {
    g[GPU_QUEUE_KEY] = new GpuQueue();
  }
  return g[GPU_QUEUE_KEY];
}
