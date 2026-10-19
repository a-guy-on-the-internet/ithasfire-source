import { TicketPrintSheet } from "./_components/TicketPrintSheet";

type TicketPrintPageProps = {
  params: Promise<{ orderId: string }>;
};

/**
 * `/my-tickets/[orderId]/print` — the printable ticket sheet.
 *
 * Server shell only: the sheet is a client island because it reads the two
 * ownership-checked tRPC queries the order page already uses. There is no
 * server-side PDF generation anywhere in this route — the document is styled
 * for `@media print` and the browser's Print → Save as PDF produces the file.
 */
export default async function TicketPrintPage({
  params,
}: TicketPrintPageProps) {
  const { orderId } = await params;

  return <TicketPrintSheet orderId={orderId} />;
}
