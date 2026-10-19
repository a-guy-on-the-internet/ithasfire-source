import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { ApplicationFormTemplatesView } from "./_components/ApplicationFormTemplatesView";

export default function AdminApplicationFormTemplatesPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <ApplicationFormTemplatesView />
    </AdminEmailVerificationGate>
  );
}
