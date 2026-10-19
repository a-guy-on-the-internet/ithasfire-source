import { VolunteerBadgeSheet } from "./_components/VolunteerBadgeSheet";

type VolunteerBadgePrintPageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * `/admin/[slug]/events/[id]/volunteers/badges/print` — the printable
 * volunteer badge sheet.
 *
 * Server shell only: the sheet is a client island because every read it makes
 * is an org-edit-gated tRPC query and the badges are minted by a mutation the
 * operator triggers. There is no server-side PDF generation in this route and
 * there is not meant to be — the document is styled for `@media print` and the
 * browser's Print → Save as PDF produces the file.
 *
 * The route sits under `volunteers/` deliberately: badges are ORGANIZER /
 * VENUE-issued credential stock, so they belong to the surface run by whoever
 * is accountable at the door, and they inherit that surface's authorization
 * rather than inventing any. A volunteer's own printable QR is a different
 * artefact on a different route.
 */
export default async function VolunteerBadgePrintPage({
  params,
}: VolunteerBadgePrintPageProps) {
  const { slug, id } = await params;

  return <VolunteerBadgeSheet slug={slug} eventId={id} />;
}
