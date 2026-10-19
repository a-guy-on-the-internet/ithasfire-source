import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { TeamView } from "./_components/TeamView";

export default function AdminTeamPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <TeamView />
    </AdminEmailVerificationGate>
  );
}
