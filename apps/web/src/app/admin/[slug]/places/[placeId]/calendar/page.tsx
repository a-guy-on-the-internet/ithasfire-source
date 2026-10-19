import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { VenueCalendar } from "./_components/VenueCalendar";

export default function AdminPlaceCalendarPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <VenueCalendar />
    </AdminEmailVerificationGate>
  );
}
