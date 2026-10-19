import type { DisputeUseCaseDeps } from "./shared";
import { persistDisputeLifecycle } from "./shared";
import {
  disputeLifecycleOutputSchema,
  stripeDisputeLifecycleInputSchema,
  type DisputeLifecycleOutput,
  type StripeDisputeLifecycleInput,
} from "./schemas";

export const recordFundsWithdrawnInputSchema =
  stripeDisputeLifecycleInputSchema;
export const recordFundsWithdrawnOutputSchema = disputeLifecycleOutputSchema;

export type RecordFundsWithdrawnInput = StripeDisputeLifecycleInput;
export type RecordFundsWithdrawnOutput = DisputeLifecycleOutput;
export type RecordFundsWithdrawnDeps = DisputeUseCaseDeps;

export async function recordFundsWithdrawn(
  deps: RecordFundsWithdrawnDeps,
  rawInput: unknown,
): Promise<RecordFundsWithdrawnOutput> {
  return persistDisputeLifecycle(deps, rawInput, {
    operation: "funds_withdrawn",
    targetStatus: "OPEN",
    auditAction: "stripe_dispute_funds_withdrawn",
    markOrder: true,
  });
}
