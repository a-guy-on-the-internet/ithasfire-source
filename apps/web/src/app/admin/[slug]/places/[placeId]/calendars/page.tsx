import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { CalendarsManager } from "./_components/CalendarsManager";

export default function AdminPlaceCalendarsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <CalendarsManager />
    </AdminEmailVerificationGate>
  );
}
