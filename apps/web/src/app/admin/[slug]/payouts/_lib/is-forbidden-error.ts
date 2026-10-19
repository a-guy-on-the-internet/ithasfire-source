/**
 * True when a tRPC read was refused for the actor's ROLE. Both denial shapes
 * the Payouts reads throw arrive as tRPC `FORBIDDEN`:
 *   - `fail("FORBIDDEN")` (payouts.getOverview / getStatement, canFinanceOrg)
 *   - `INSUFFICIENT_ROLE` (stripeConnect.getStatus, agreements.
 *     getDefaultPayoutTerms, ORG_EDIT_OR_FINANCE_ROLES)
 * via `errorCodeMap` in `packages/transport/trpc/src/utils.ts`.
 *
 * A role refusal is a fact about the reader, not an outage: callers show a
 * plain role notice instead of an error with Retry.
 */
export function isForbiddenError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: { code?: unknown } | null }).data;
  return data?.code === "FORBIDDEN";
}
