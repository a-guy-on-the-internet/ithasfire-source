import type { Metadata } from "next";

import { InvitePauseQueue } from "./_components/InvitePauseQueue";

export const metadata: Metadata = {
  title: "Invite pauses",
  description:
    "Review organisers whose invite emails were paused for spam complaints.",
};

// Access gating lives in PlatformShell (checkStaffAccess client gate) + the
// tRPC procedures' own staff authz (ADMIN/REVIEWER/SUPPORT read,
// ADMIN/REVIEWER decide), same as the sibling /platform sections; do not
// re-gate here.
export default function PlatformInvitePausesPage() {
  return <InvitePauseQueue />;
}
