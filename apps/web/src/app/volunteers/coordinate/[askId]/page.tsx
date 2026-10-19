import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";

import { CoordinatorConsole } from "./_components/CoordinatorConsole";

export const metadata: Metadata = {
  title: "Coordinate Volunteers",
  description: "Manage your volunteer group.",
};

type PageProps = {
  params: Promise<{ askId: string }>;
};

export default async function CoordinateAskPage({ params }: PageProps) {
  const { askId } = await params;
  return (
    <PageContainer maxWidth={880} gap={32} padding="32px 0">
      <CoordinatorConsole askId={askId} />
    </PageContainer>
  );
}
