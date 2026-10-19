import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { ScannerSetupView } from "./_components/ScannerSetupView";

export default function AdminScannerSetupPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <ScannerSetupView />
    </AdminEmailVerificationGate>
  );
}
