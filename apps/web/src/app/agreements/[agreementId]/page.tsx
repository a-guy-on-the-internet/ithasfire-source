import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { AgreementEditor } from "./_components/AgreementEditor";

export const metadata: Metadata = {
  title: "Booking Agreement",
  description: "Negotiate the terms of a booking agreement.",
};

type AgreementPageProps = {
  params: Promise<{ agreementId: string }>;
};

export default async function AgreementPage({ params }: AgreementPageProps) {
  const { agreementId } = await params;

  return (
    <PageContainer maxWidth={840} gap={32} padding="32px 0">
      <AgreementEditor agreementId={agreementId} />
    </PageContainer>
  );
}
