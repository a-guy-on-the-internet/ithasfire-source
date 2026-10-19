import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { BookingsWorkspace } from "./_components/BookingsWorkspace";

export default function AdminBookingsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <BookingsWorkspace />
    </AdminEmailVerificationGate>
  );
}
