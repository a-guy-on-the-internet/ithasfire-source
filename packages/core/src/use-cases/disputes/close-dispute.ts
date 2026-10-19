import type { DisputeUseCaseDeps } from "./shared";
import { parseInput } from "../../lib/io";
import {
  mapStripeClosedDisputeStatus,
  persistDisputeLifecycle,
} from "./shared";
import {
  disputeLifecycleOutputSchema,
  stripeDisputeLifecycleInputSchema,
  type DisputeLifecycleOutput,
  type StripeDisputeLifecycleInput,
} from "./schemas";

export const closeDisputeInputSchema = stripeDisputeLifecycleInputSchema;
export const closeDisputeOutputSchema = disputeLifecycleOutputSchema;

export type CloseDisputeInput = StripeDisputeLifecycleInput;
export type CloseDisputeOutput = DisputeLifecycleOutput;
export type CloseDisputeDeps = DisputeUseCaseDeps;

export async function closeDispute(
  deps: CloseDisputeDeps,
  rawInput: unknown,
): Promise<CloseDisputeOutput> {
  const parsed = parseInput(closeDisputeInputSchema, rawInput);
  return persistDisputeLifecycle(deps, rawInput, {
    operation: "close",
    targetStatus: mapStripeClosedDisputeStatus(
      parsed.stripeStatus,
      parsed.outcome,
      parsed.isWarning,
    ),
    auditAction: "stripe_dispute_closed",
    markOrder: !parsed.isWarning,
  });
}
