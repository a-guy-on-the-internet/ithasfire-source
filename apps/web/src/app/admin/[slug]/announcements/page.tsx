import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { AnnouncementsView } from "./_components/AnnouncementsView";

export default function AdminAnnouncementsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <AnnouncementsView />
    </AdminEmailVerificationGate>
  );
}
