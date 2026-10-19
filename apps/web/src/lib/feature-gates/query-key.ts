import type { QueryKey } from "@tanstack/react-query";

/**
 * Builds the React Query cache key that tRPC v11 generates for
 * `trpc.features.getFeatureGates.useQuery(undefined)`.
 *
 * tRPC v11 key format (from getQueryKeyInternal):
 *   input === undefined → [path, { type }]
 *
 * Keep in sync with the procedure path in `@th/trpc` router and the
 * tRPC version's key algorithm. If the tRPC major version changes,
 * verify with `getQueryKey(trpc.features.getFeatureGates, undefined, 'query')`.
 */
export function featureGatesQueryKey(): QueryKey {
  return [["features", "getFeatureGates"], { type: "query" }];
}
