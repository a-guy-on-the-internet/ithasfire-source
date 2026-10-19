import { HoursStatementSheet } from "./_components/HoursStatementSheet";

/**
 * `/my-volunteering/hours/print` — the printable volunteer hours statement.
 *
 * Server shell only: the sheet is a client island because it reads the
 * ownership-checked `volunteer.signups.listMyCommitments` query the
 * `/my-volunteering` page already uses. There is no server-side PDF generation
 * on this route — the document is styled for `@media print` and the browser's
 * Print then Save-as-PDF produces the file.
 */
export default function VolunteerHoursPrintPage() {
  return <HoursStatementSheet />;
}
