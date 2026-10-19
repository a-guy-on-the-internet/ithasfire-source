import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { MembershipsView } from "./_components/MembershipsView";

export default function AdminMembershipsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <MembershipsView />
    </AdminEmailVerificationGate>
  );
}
