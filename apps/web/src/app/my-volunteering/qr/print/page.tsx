import { VolunteerQrSheet } from "./_components/VolunteerQrSheet";

type VolunteerQrPrintPageProps = {
  searchParams: Promise<{ event?: string | string[] }>;
};

/**
 * `/my-volunteering/qr/print` — the volunteer's OWN printable check-in code.
 *
 * A QR, not a badge. Badge stock is venue-issued and lives under
 * `/admin/[slug]/events/[id]/volunteers/badges/print`; this is "scan me in" for
 * the volunteer whose phone is dead, and it admits nobody by itself.
 *
 * Server shell only: the sheet is a client island because it reads the same
 * session-scoped self-read `/my-volunteering` uses and mints its code from a
 * mutation the volunteer triggers. There is no server-side PDF generation here
 * and there is not meant to be — the document is styled for `@media print` and
 * the browser's Print → Save as PDF produces the file.
 *
 * `?event=` scopes the code, because a scan token is human+EVENT scoped: one
 * code already covers every approved shift the volunteer holds at that event.
 * An array (`?event=a&event=b`) is rejected rather than silently reduced — a
 * code printed for the wrong event scans as `volunteer_qr_wrong_event` at the
 * door with nothing on the paper to explain why.
 */
export default async function VolunteerQrPrintPage({
  searchParams,
}: VolunteerQrPrintPageProps) {
  const { event } = await searchParams;
  const eventId = typeof event === "string" && event.length > 0 ? event : null;

  return <VolunteerQrSheet eventId={eventId} />;
}
