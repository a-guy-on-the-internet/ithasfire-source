import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { EmbedsView } from "./_components/EmbedsView";

export default function AdminEmbedsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <EmbedsView />
    </AdminEmailVerificationGate>
  );
}
