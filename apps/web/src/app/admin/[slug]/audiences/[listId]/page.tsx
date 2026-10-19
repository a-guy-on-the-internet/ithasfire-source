import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { AudienceDetail } from "./_components/AudienceDetail";

export default function AdminAudienceDetailPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <AudienceDetail />
    </AdminEmailVerificationGate>
  );
}
