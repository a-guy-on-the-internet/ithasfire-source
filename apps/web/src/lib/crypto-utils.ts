/**
 * Generate a 20-char hex client key from a random UUID.
 * Used as a client-side idempotency key for mutations.
 */
export const buildFreshClientKey = () =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 20);
