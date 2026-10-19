export interface QueuePort {
  enqueue<T>(
    queue: string,
    payload: T,
    opts?: { delayMs?: number; id?: string },
  ): Promise<void>;
  process<T>(queue: string, handler: (payload: T) => Promise<void>): void;
}
