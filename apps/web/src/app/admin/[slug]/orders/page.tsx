"use client";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { OrdersTable } from "./_components/OrdersTable";

// The Settlements tab that used to sit beside Orders is gone: it read the
// frozen `Settlement` table, which the 2026-08-10 ledger cutover left with no
// writers, so it rendered empty for every organiser. The organiser's money
// view is `/admin/<slug>/payouts` now. With one view left there is no tab bar.
export default function AdminOrdersPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <OrdersTable />
    </AdminEmailVerificationGate>
  );
}
