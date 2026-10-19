import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PlaceLayoutEditor } from "./_components/PlaceLayoutEditor";

export default function AdminPlaceLayoutPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <PlaceLayoutEditor />
    </AdminEmailVerificationGate>
  );
}
