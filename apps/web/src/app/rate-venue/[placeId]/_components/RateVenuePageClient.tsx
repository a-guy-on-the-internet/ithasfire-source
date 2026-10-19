"use client";

import { CommunityVenueReviewForm } from "@/app/_components/community-venue-review";

interface RateVenuePageClientProps {
  placeId: string;
}

export function RateVenuePageClient({ placeId }: RateVenuePageClientProps) {
  return (
    <div
      style={{
        width: "100%",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        background: "color-mix(in srgb, var(--color, #211C16) 2%, transparent)",
      }}
    >
      <CommunityVenueReviewForm placeId={placeId} />
    </div>
  );
}
