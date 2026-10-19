import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";

import { PublicAskView } from "./_components/PublicAskView";

export const metadata: Metadata = {
  title: "Volunteer",
  description: "Sign up to volunteer.",
};

type PageProps = {
  params: Promise<{ askId: string }>;
};

export default async function PublicAskPage({ params }: PageProps) {
  const { askId } = await params;
  return (
    <PageContainer maxWidth={720} gap={32} padding="32px 0">
      <PublicAskView askId={askId} />
    </PageContainer>
  );
}
