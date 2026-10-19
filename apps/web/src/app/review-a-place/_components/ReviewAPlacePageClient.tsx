"use client";

import { PlaceReviewForm } from "@/app/_components/place-review";

interface ReviewAPlacePageClientProps {
  prefillName?: string;
  prefillEmail?: string;
  placeId?: string;
  placeName?: string;
  campaign?: string;
}

export function ReviewAPlacePageClient({
  prefillName,
  prefillEmail,
  placeId,
  placeName,
  campaign,
}: ReviewAPlacePageClientProps) {
  return (
    <div
      style={{
        width: "100%",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        background: "rgba(0, 0, 0, 0.02)",
      }}
    >
      <PlaceReviewForm
        variant="page"
        prefill={{
          name: prefillName,
          email: prefillEmail,
          placeId: placeId,
          placeName: placeName,
          campaign: campaign,
        }}
      />
    </div>
  );
}
