import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PayoutsView } from "./_components/PayoutsView";

export default function AdminPayoutsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <PayoutsView />
    </AdminEmailVerificationGate>
  );
}
