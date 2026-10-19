import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { MyLineups } from "./_components/MyLineups";

export const metadata: Metadata = {
  title: "My lineups",
  description:
    "Events where an organiser has put your name on the lineup. Private to you.",
};

export default function MyLineupsPage() {
  return (
    <PageContainer maxWidth={672} gap={32} padding="32px 0">
      <MyLineups />
    </PageContainer>
  );
}
