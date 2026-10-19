import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

// Derive the ineligibility reason union straight from the tRPC contract so the
// UI can never drift from the core `getEligibility` output.
type EligibilityOutput =
  inferRouterOutputs<AppRouter>["attendeeReviews"]["getEligibility"];

export type AttendeeReviewIneligibilityReason = NonNullable<
  EligibilityOutput["reason"]
>;
