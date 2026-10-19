import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { MyVolunteering } from "./_components/MyVolunteering";

export const metadata: Metadata = {
  title: "My Volunteering",
  description:
    "Your volunteer shifts, applications, and hours. Private to you.",
};

export default function MyVolunteeringPage() {
  return (
    <PageContainer maxWidth={672} gap={32} padding="32px 0">
      <MyVolunteering />
    </PageContainer>
  );
}
