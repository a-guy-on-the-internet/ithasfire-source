import { type Metadata } from "next";

import { RateVenuePageClient } from "./_components/RateVenuePageClient";

// Shareable, noindex deep-link that hosts the SAME community review form as the
// on-page rate_venue modal (venue-rating-block-and-owner-optin FR-002/FR-009).
// Used for external links and post-visit prompts; the modal is the primary
// on-page entry, this route is the fallback.
export const metadata: Metadata = {
  title: "Rate a place",
  description: "Share your experience visiting a place.",
  robots: {
    index: false,
    follow: false,
  },
};

interface RateVenuePageProps {
  params: Promise<{ placeId: string }>;
}

export default async function RateVenuePage({ params }: RateVenuePageProps) {
  const { placeId } = await params;

  return <RateVenuePageClient placeId={placeId} />;
}
