import type { Metadata } from "next";

import { ReviewEventPageClient } from "./_components/ReviewEventPageClient";

// Authed, per-attendee surface reached from the post-event prompt email
// (?campaign=post-event-prompt) and the my-tickets CTA. Never indexed.
export const metadata: Metadata = {
  title: "Rate this show",
  description: "Share your feedback from a show you attended.",
  robots: {
    index: false,
    follow: false,
  },
};

interface ReviewEventPageProps {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ campaign?: string }>;
}

export default async function ReviewEventPage({
  params,
  searchParams,
}: ReviewEventPageProps) {
  const { eventId } = await params;
  const { campaign } = await searchParams;

  return <ReviewEventPageClient eventId={eventId} campaign={campaign} />;
}
