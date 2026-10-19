import { type Metadata } from "next";
import { ReviewAPlacePageClient } from "./_components/ReviewAPlacePageClient";

export const metadata: Metadata = {
  title: "Rate a place",
  description:
    "Share your experience playing at a place to help other artists know what to expect.",
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    title: "Rate a place | Ithas Fire",
    description:
      "Share your experience playing at a place to help other artists know what to expect.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Rate a place | Ithas Fire",
    description:
      "Share your experience playing at a place to help other artists know what to expect.",
  },
};

interface ReviewAPlacePageProps {
  searchParams: Promise<{
    name?: string;
    email?: string;
    place?: string;
    placeId?: string;
    campaign?: string;
  }>;
}

export default async function ReviewAPlacePage({
  searchParams,
}: ReviewAPlacePageProps) {
  const params = await searchParams;

  return (
    <ReviewAPlacePageClient
      prefillName={params.name}
      prefillEmail={params.email}
      placeId={params.placeId}
      placeName={params.place}
      campaign={params.campaign}
    />
  );
}
