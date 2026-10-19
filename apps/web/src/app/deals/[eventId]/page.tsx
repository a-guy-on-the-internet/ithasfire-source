import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { EventDealPage } from "./_components/EventDealPage";

export const metadata: Metadata = {
  title: "The deal",
  description: "An event's deal and every change to it since it froze.",
  robots: { index: false, follow: false },
};

type DealPageProps = {
  params: Promise<{ eventId: string }>;
};

/**
 * Where the deal-change notice links (freeze-the-deal FR-007): a payee's
 * view of the event's deal and its changes. Signed-in only (middleware's
 * private-route gate); who may read it is decided by `deals.listDealChanges`.
 */
export default async function DealPage({ params }: DealPageProps) {
  const { eventId } = await params;
  return (
    <PageContainer maxWidth={840} gap={32} padding="32px 0">
      <EventDealPage eventId={eventId} />
    </PageContainer>
  );
}
