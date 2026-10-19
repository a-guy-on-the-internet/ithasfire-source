import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { AudienceImport } from "./_components/AudienceImport";

export default function AdminAudienceImportPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <AudienceImport />
    </AdminEmailVerificationGate>
  );
}
