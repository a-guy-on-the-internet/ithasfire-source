import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PlacesTable } from "./_components/PlacesTable";

export default function AdminPlacesPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <PlacesTable />
    </AdminEmailVerificationGate>
  );
}
