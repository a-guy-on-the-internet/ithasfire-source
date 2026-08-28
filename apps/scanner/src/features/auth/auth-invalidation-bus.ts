/**
 * Tiny pub/sub for "the operator's session was invalidated server-side."
 *
 * Wiring: the tRPC fetch wrapper (`apps/scanner/src/trpc.ts`) calls
 * `notifyAuthInvalidated()` whenever an HTTP response comes back as 401.
 * `useScannerSession` subscribes once and triggers `signOut` on notify, which
 * (via slice 2) wipes the local SQLite cache. That is the scanner's
 * "remote wipe" path — when an admin revokes the operator's auth session on
 * the server, the next API call returns 401, the device signs out, and all
 * cached PII is dropped.
 *
 * Kept intentionally tiny and dependency-free so it can be imported from both
 * the tRPC client (no React) and the session hook (React).
 */

type Listener = () => void | Promise<void>;

const listeners = new Set<Listener>();

function reportListenerError(kind: "rejected" | "threw", err: unknown): void {
  // Keep pub/sub delivery best-effort while still surfacing failures in all envs.
  // eslint-disable-next-line no-console
  console.error(`[scanner] auth-invalidation listener ${kind}`, err);
}

export function notifyAuthInvalidated(): void {
  for (const l of [...listeners]) {
    try {
      const result = l();
      if (result && typeof (result as Promise<void>).catch === "function") {
        void result.catch((err) => {
          reportListenerError("rejected", err);
        });
      }
    } catch (err) {
      reportListenerError("threw", err);
    }
  }
}

export function subscribeAuthInvalidated(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
