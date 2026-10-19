import type { DisputeUseCaseDeps } from "./shared";
import { parseInput } from "../../lib/io";
import { mapStripeDisputeStatus, persistDisputeLifecycle } from "./shared";
import {
  disputeLifecycleOutputSchema,
  stripeDisputeLifecycleInputSchema,
  type DisputeLifecycleOutput,
  type StripeDisputeLifecycleInput,
} from "./schemas";

export const refreshDisputeInputSchema = stripeDisputeLifecycleInputSchema;
export const refreshDisputeOutputSchema = disputeLifecycleOutputSchema;

export type RefreshDisputeInput = StripeDisputeLifecycleInput;
export type RefreshDisputeOutput = DisputeLifecycleOutput;
export type RefreshDisputeDeps = DisputeUseCaseDeps;

export async function refreshDispute(
  deps: RefreshDisputeDeps,
  rawInput: unknown,
): Promise<RefreshDisputeOutput> {
  const parsed = parseInput(refreshDisputeInputSchema, rawInput);
  return persistDisputeLifecycle(deps, rawInput, {
    operation: "refresh",
    targetStatus: mapStripeDisputeStatus(parsed.stripeStatus, parsed.isWarning),
    auditAction: "stripe_dispute_refreshed",
    markOrder: !parsed.isWarning,
  });
}
