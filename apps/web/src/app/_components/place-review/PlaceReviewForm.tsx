"use client";

import { PlaceReviewFormOrchestrator } from "./PlaceReviewFormOrchestrator";
import type { PlaceReviewFormProps } from "./types";

/**
 * Reusable place review form component.
 *
 * Supports two variants:
 * - "embedded": Renders in the homepage Coming Soon section (channel: "homepage")
 * - "page": Renders as a standalone page (channel: "email" with campaign, or "direct" without)
 *
 * @example
 * // Embedded in Coming Soon
 * <PlaceReviewForm
 *   variant="embedded"
 *   prefill={{ name: "Jane", email: "jane@example.com" }}
 * />
 *
 * @example
 * // Standalone page with email campaign
 * <PlaceReviewForm
 *   variant="page"
 *   prefill={{ campaign: "outreach-2026-05" }}
 *   onSubmitted={() => router.push('/browse-events')}
 * />
 */
export function PlaceReviewForm({
  prefill,
  variant = "embedded",
  chromeless = false,
  onSubmitted,
}: PlaceReviewFormProps = {}) {
  return (
    <PlaceReviewFormOrchestrator
      initialName={prefill?.name}
      initialEmail={prefill?.email}
      initialPlaceId={prefill?.placeId}
      initialPlaceName={prefill?.placeName}
      variant={variant}
      chromeless={chromeless}
      campaign={prefill?.campaign}
      onSubmitted={onSubmitted}
    />
  );
}
