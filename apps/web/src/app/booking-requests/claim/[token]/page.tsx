import type { Metadata } from "next";

import { ClaimBookingRequest } from "./_components/ClaimBookingRequest";

// The token in the path is a single-use bearer credential — never index it.
export const metadata: Metadata = {
  title: "Claim your booking",
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ token: string }>;
};

/**
 * Invite-to-claim landing (booking-request-embed-button FR-007): a venue
 * accepted an anonymous booking inquiry and emailed the submitter this link.
 * The client island handles sign-in redirect, the performer-mode gate, sender
 * selection, and the claim mutation. The raw token is passed straight through
 * to the mutation — never logged or sent to analytics.
 */
export default async function ClaimBookingRequestPage({ params }: Props) {
  const { token } = await params;
  return <ClaimBookingRequest token={token ?? null} />;
}
