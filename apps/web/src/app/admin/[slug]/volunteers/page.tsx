import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { VolunteersHome } from "./_components/VolunteersHome";

export default function AdminVolunteersPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <VolunteersHome />
    </AdminEmailVerificationGate>
  );
}
