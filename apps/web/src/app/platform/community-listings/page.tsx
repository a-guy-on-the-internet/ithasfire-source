import type { Metadata } from "next";

import { CommunityListingsView } from "./_components/CommunityListingsView";

export const metadata: Metadata = {
  title: "Community listings",
};

// Access gating lives in the platform layout (server) and PlatformShell
// (client); `community.listListingsForPlatform` is platform-ADMIN-only on the
// server and the view shows a denied state on FORBIDDEN. Do not re-gate here.
export default function PlatformCommunityListingsPage() {
  return <CommunityListingsView />;
}
