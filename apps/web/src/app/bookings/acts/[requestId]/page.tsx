import type { Metadata } from "next";

import { ActInvitePage } from "./_components/ActInvitePage";

// The lineup invite (lineup v3 FR-013). Private to the acts on the bill, so
// never indexed; the auth gate in AppChrome sends a signed-out visitor to
// sign-in and back.
export const metadata: Metadata = {
  title: "You're on a bill",
  description: "Answer an invite to a bill at a place.",
  robots: {
    index: false,
    follow: false,
  },
};

interface ActInviteRouteProps {
  params: Promise<{ requestId: string }>;
}

export default async function ActInviteRoute({ params }: ActInviteRouteProps) {
  const { requestId } = await params;
  return <ActInvitePage requestId={requestId} />;
}
