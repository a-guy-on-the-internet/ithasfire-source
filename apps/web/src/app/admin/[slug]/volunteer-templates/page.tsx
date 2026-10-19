import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { VolunteerTemplatesView } from "./_components/VolunteerTemplatesView";

export default function AdminVolunteerTemplatesPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <VolunteerTemplatesView />
    </AdminEmailVerificationGate>
  );
}
