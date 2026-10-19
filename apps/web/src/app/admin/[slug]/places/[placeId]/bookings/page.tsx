import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PlaceBookingInbox } from "./_components/PlaceBookingInbox";

export default function AdminPlaceBookingsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <PlaceBookingInbox />
    </AdminEmailVerificationGate>
  );
}
