import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { DashboardContent } from "./_components/DashboardContent";

export default function AdminDashboardPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <DashboardContent />
    </AdminEmailVerificationGate>
  );
}
