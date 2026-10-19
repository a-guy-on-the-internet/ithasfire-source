/**
 * The "auth epoch": a counter bumped on every deliberate sign-out made through
 * `authClient`, plus a subscribe/notify pair so the tRPC provider can drop its
 * minted bearer token at that moment.
 *
 * Deliberately dependency-free (no React, no Better Auth runtime) so both the
 * auth client's fetch plugin and `trpc.ts` can import it without dragging
 * either into the other.
 *
 * Why an explicit signal instead of watching the session atom settle
 * signed-out: Better Auth's get-session can transiently return null for a
 * signed-in user (cookie race, network blip) — `useSessionVerdict` latches
 * signed-in for exactly that reason. Clearing the token cache on that reading
 * would throw away a valid token. A successful `/sign-out` response is
 * unambiguous.
 */

let epoch = 0;
const listeners = new Set<() => void>();

/** The current epoch. A value captured before an await that differs after it
 * means a sign-out happened in between. */
export function getAuthEpoch(): number {
  return epoch;
}

/**
 * Subscribe to deliberate sign-outs. Returns the unsubscribe function.
 * Listeners must not throw: they run inside the auth client's fetch hook, so
 * a throw would reject the caller's `signOut()`.
 */
export function subscribeSignedOut(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Bump the epoch, then tell every listener. Called by the auth client plugin. */
export function notifySignedOut(): void {
  // Bump FIRST so a listener (or a mint resolving in a later microtask) that
  // reads the epoch already sees the new value.
  epoch += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}
