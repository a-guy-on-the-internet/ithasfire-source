/**
 * Helpers for narrowing tRPC client errors without resorting to inline casts.
 *
 * tRPC client errors come back as `unknown` to the catch handler. The shape
 * we care about is `{ data?: { code?: string } }` plus an optional `message`.
 * Centralizing this here keeps cast-shape strings out of feature code.
 */

export const getTrpcErrorCode = (err: unknown): string => {
  if (!err || typeof err !== "object" || !("data" in err)) return "";
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) return "";
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
};

/**
 * True for errors that should be retried by the offline queue: network blips,
 * server-side 5xx, timeouts. Permanent errors (validation, forbidden, etc.)
 * are surfaced to the operator immediately.
 */
export const isTransientTrpcError = (err: unknown): boolean => {
  const code = getTrpcErrorCode(err);
  if (!code) {
    // No tRPC code → likely a network-layer failure.
    return err instanceof TypeError && /network/i.test(err.message);
  }
  return code === "INTERNAL_SERVER_ERROR" || code === "TIMEOUT";
};
