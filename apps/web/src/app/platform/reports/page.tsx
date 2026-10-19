import type { Metadata } from "next";

import { EntityReportQueue } from "./_components/EntityReportQueue";

export const metadata: Metadata = {
  title: "Listing Reports",
  description: "Review reports filed against place, person, and group listings.",
};

// Access gating lives in PlatformShell (checkStaffAccess client gate) + the
// tRPC procedures' own staff authz — same as the sibling /platform sections;
// do not re-gate here. (Spec v1.1: entity reports are PLATFORM trust &
// safety, not community moderation.)
export default function PlatformReportsPage() {
  return <EntityReportQueue />;
}
