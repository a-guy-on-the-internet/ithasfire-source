import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { AudiencesView } from "./_components/AudiencesView";

export default function AdminAudiencesPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <AudiencesView />
    </AdminEmailVerificationGate>
  );
}
