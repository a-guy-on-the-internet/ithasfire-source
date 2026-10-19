import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PromosView } from "./_components/PromosView";

export default function AdminPromosPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <PromosView />
    </AdminEmailVerificationGate>
  );
}
