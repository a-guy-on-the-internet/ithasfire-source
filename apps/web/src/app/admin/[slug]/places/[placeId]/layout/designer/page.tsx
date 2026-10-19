import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PlaceLayoutDesigner } from "../_components/designer";

export default function AdminPlaceLayoutDesignerPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <PlaceLayoutDesigner />
    </AdminEmailVerificationGate>
  );
}
