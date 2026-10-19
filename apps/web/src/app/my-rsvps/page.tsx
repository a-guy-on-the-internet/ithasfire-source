import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { MyRsvps } from "./_components/MyRsvps";

export const metadata: Metadata = {
  title: "My RSVPs",
  description: "Community events you said you're going to. Private to you.",
};

export default function MyRsvpsPage() {
  return (
    <PageContainer maxWidth={672} gap={32} padding="32px 0">
      <MyRsvps />
    </PageContainer>
  );
}
