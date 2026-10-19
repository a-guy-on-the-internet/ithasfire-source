import type { Metadata } from "next";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { AdminAgreementPage } from "./_components/AdminAgreementPage";

export const metadata: Metadata = {
  title: "Booking agreement",
  description: "Finish the terms of a booking without leaving it.",
};

type PageProps = {
  params: Promise<{ slug: string; agreementId: string }>;
};

/**
 * `/admin/{slug}/bookings/agreement/{agreementId}` — the agreement editor,
 * INSIDE the admin shell, one click from the booking it belongs to.
 *
 * Keyed on the AGREEMENT id, not the request: there is no by-id read for a
 * booking request, and `bookingAgreements.get` already returns the request
 * (and the linked event) the stage rail needs. A nested route, deliberately
 * not a nav item — `AdminShell` pins its route ids, and this page is reached
 * from a booking, never from the rail.
 *
 * Auth: the admin layout bounces anonymous requests server-side, and the
 * agreement read itself is party-gated — a non-party gets the editor's own
 * "not yours" state, never partial data.
 */
export default async function AdminBookingAgreementPage({ params }: PageProps) {
  const { slug, agreementId } = await params;
  return (
    <AdminEmailVerificationGate mode="block">
      <AdminAgreementPage slug={slug} agreementId={agreementId} />
    </AdminEmailVerificationGate>
  );
}
