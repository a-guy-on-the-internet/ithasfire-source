import type { Metadata } from "next";

import { CashDebtsView } from "./_components/CashDebtsView";

export const metadata: Metadata = {
  title: "Unpaid tax on cash",
  description:
    "Tax on door cash sales, plus the platform fee on sales from before Oct 8, 2026, that no payout has covered for more than 30 days.",
};

// Access gating lives in the platform layout (server) and PlatformShell
// (client), plus `platform.listUnrecoveredCashDebts`' own staff authz
// (ADMIN/SUPPORT, STAFF_ONLY otherwise), same as the sibling /platform
// sections; do not re-gate here.
export default function PlatformCashDebtsPage() {
  return <CashDebtsView />;
}
