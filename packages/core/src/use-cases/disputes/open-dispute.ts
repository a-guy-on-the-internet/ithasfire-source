import type { DisputeUseCaseDeps } from "./shared";
import { parseInput } from "../../lib/io";
import { mapStripeDisputeStatus, persistDisputeLifecycle } from "./shared";
import {
  disputeLifecycleOutputSchema,
  stripeDisputeLifecycleInputSchema,
  type DisputeLifecycleOutput,
  type StripeDisputeLifecycleInput,
} from "./schemas";

export const openDisputeInputSchema = stripeDisputeLifecycleInputSchema;
export const openDisputeOutputSchema = disputeLifecycleOutputSchema;

export type OpenDisputeInput = StripeDisputeLifecycleInput;
export type OpenDisputeOutput = DisputeLifecycleOutput;
export type OpenDisputeDeps = DisputeUseCaseDeps;

export async function openDispute(
  deps: OpenDisputeDeps,
  rawInput: unknown,
): Promise<OpenDisputeOutput> {
  const parsed = parseInput(openDisputeInputSchema, rawInput);
  return persistDisputeLifecycle(deps, rawInput, {
    operation: "open",
    targetStatus: parsed.isWarning
      ? mapStripeDisputeStatus(parsed.stripeStatus, true)
      : "OPEN",
    auditAction: "stripe_dispute_opened",
    markOrder: !parsed.isWarning,
  });
}
