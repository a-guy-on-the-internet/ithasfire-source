/**
 * Bounds a request that may never answer.
 *
 * The app's fetch has no timeout (`trpc.ts`), and a half-open connection (venue
 * wifi that drops mid-request) leaves a request neither answered nor failed.
 * Anything that waits on one request before starting the next then waits for
 * the rest of the app run: the scan queue's pass, the session re-check.
 *
 * `run` is handed an `AbortSignal`. When the time is up the signal is aborted,
 * so a tRPC call given it (`client.x.mutate(input, { signal })`) cancels its
 * HTTP request, and the returned promise rejects with
 * {@link RequestTimeoutError} whether or not `run` honours the signal. The
 * abort is best effort: the server may already have the request, so a caller
 * that sends something must send it under an idempotency key.
 *
 * Pure: no React, no native imports.
 */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no answer after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export const isRequestTimeout = (err: unknown): err is RequestTimeoutError =>
  err instanceof RequestTimeoutError;

export function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new RequestTimeoutError(timeoutMs));
    }, timeoutMs);
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    let pending: Promise<T>;
    try {
      pending = run(controller.signal);
    } catch (err) {
      settle(() => reject(err));
      return;
    }
    pending.then(
      (value) => settle(() => resolve(value)),
      (err: unknown) => settle(() => reject(err)),
    );
  });
}
