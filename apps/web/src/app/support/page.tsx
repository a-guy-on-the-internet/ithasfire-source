import type { Metadata } from "next";

import { getSupportEmail } from "@/server/support";
import { SupportContent } from "./_components/SupportContent";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with tickets, events, refunds, and your Ithas Fire account. Search the Help Centre, reach the event organiser, or contact us.",
};

// Public, no-auth page: this is the SUPPORT_URL target linked from customer
// transactional emails (receipts, refunds, resale). Recipients may be logged
// out, so everything here must render without a session.
export default async function SupportPage() {
  const supportEmail = await getSupportEmail();
  return <SupportContent supportEmail={supportEmail} />;
}
