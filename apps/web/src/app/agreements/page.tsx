import type { Metadata } from "next";

import { AgreementsRedirect } from "./_components/AgreementsRedirect";

export const metadata: Metadata = {
  title: "Agreements",
  robots: { index: false, follow: false },
};

/**
 * `/agreements` — RETIRED as a list (2026-08-26, "agreements inside the
 * booking"). Venues and orgs read their agreements in the admin Bookings
 * inbox's Agreement tab; performers in Account settings → Booking requests.
 * The route stays as a redirector so old links and the private-route gate
 * keep working. `/agreements/{id}` is untouched.
 */
export default function AgreementsPage() {
  return <AgreementsRedirect />;
}
