"use client";

import { AttendeeReviewsPublicToggle } from "./AttendeeReviewsPublicToggle";
import { CommunityReviewsToggle } from "./CommunityReviewsToggle";
import { OwnerAttendeeFeedbackPanel } from "./OwnerAttendeeFeedbackPanel";

/**
 * The venue's two review controls, which have always shipped as a pair:
 * the owner opt-in that PUBLISHES the attendee rating summary, and the
 * owner-only panel that shows the raw, unattributed feedback whether it is
 * published or not (venue-rating-block-and-owner-optin FR-004/FR-006).
 *
 * Neither is gated on verification — an owner may publish or read attendee
 * feedback at any time. They used to ride both the public-page editor's
 * unverified gate screen and its verified settings drawer; they now live in
 * ONE place, the venue settings page's "Reviews & feedback" section, because
 * publishing ratings is a venue policy rather than page content.
 *
 * PURE and PROP-TAKING. `canManage` is forwarded, never re-derived: the page
 * around these controls already holds the `places.getPlaceForEdit` read that
 * carries `viewerCanManageSwitches`, and a second subscription here would buy
 * nothing but another cache key to keep in step. It fails CLOSED — a payload
 * that could not be resolved leaves the switch locked rather than live.
 */
export type ReviewsSectionProps = {
  placeId: string;
  /** `place.attendeeReviewsPublic` — the toggle's initial position. */
  attendeeReviewsPublic: boolean;
  /**
   * `place.communityReviewsEnabled` — the PERFORMER-review switch's initial
   * position (venue-track-record-and-review-switch FR-007). Same bar, same
   * lock, same `embedded` treatment as the attendee toggle beside it.
   */
  communityReviewsEnabled: boolean;
  /** `place.viewerCanManageSwitches`. Locks the toggle and states why. */
  canManage: boolean;
  /**
   * Forwarded to both switches AND the feedback panel: drop their standalone
   * bordered cards so they read as subsections of a host that already drew
   * the frame. Same prop, same meaning, one convention.
   */
  embedded?: boolean;
};

export function ReviewsSection({
  placeId,
  attendeeReviewsPublic,
  communityReviewsEnabled,
  canManage,
  embedded = false,
}: ReviewsSectionProps) {
  return (
    <>
      <AttendeeReviewsPublicToggle
        placeId={placeId}
        initialIsPublic={attendeeReviewsPublic}
        canManage={canManage}
        embedded={embedded}
      />
      <CommunityReviewsToggle
        placeId={placeId}
        initialEnabled={communityReviewsEnabled}
        canManage={canManage}
        embedded={embedded}
      />
      <OwnerAttendeeFeedbackPanel placeId={placeId} embedded={embedded} />
    </>
  );
}
