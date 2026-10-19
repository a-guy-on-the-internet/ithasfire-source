import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { MyEvents } from "./_components/MyEvents";

/**
 * The URL stays `/my-tickets` — bookmarks, the consumer bottom-bar tab and a
 * dozen e2e specs point at it. Only the name changed: the page absorbed the
 * `/saved` watchlist on 2026-08-31, so it now holds events with no ticket
 * attached and "My tickets" would be wrong.
 */
export const metadata: Metadata = {
  title: "My Events",
  description: "Your tickets and your saved events, upcoming and past.",
};

export default function MyEventsPage() {
  return (
    <PageContainer maxWidth={672} gap={32} padding="32px 0">
      <MyEvents />
    </PageContainer>
  );
}
