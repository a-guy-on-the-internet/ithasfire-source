/**
 * Safely extract a string value from an order-item `meta` JSON blob.
 *
 * Order item metadata is typed as `unknown`; most call sites cast to
 * `Record<string, unknown>` inline, which is noisy and repeated. This
 * helper centralises the cast and returns `undefined` when the key is
 * missing or not a string.
 */
export function getMetaString(meta: unknown, key: string): string | undefined {
  if (meta == null || typeof meta !== "object") return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Safely extract a number value from an order-item `meta` JSON blob.
 * Returns `null` when the key is missing or not a number.
 */
export function getMetaNumber(meta: unknown, key: string): number | null {
  if (meta == null || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}
