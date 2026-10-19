import type { Metadata } from "next";

import { PageContainer } from "@/components/layout/PagePrimitives";
import { getSupportEmail } from "@/server/support";
import { OrderDetail } from "./_components/OrderDetail";

export const metadata: Metadata = {
  title: "Order Details",
  description: "View your order and ticket details.",
};

type OrderDetailPageProps = {
  params: Promise<{ orderId: string }>;
};

export default async function OrderDetailPage({
  params,
}: OrderDetailPageProps) {
  const { orderId } = await params;
  // Platform support address (same source as the email footer / /support page),
  // passed to the client island for the "get help" section's contact-support
  // fallback. Always resolves to a real address.
  const supportEmail = await getSupportEmail();

  return (
    <PageContainer maxWidth={672} gap={32} padding="32px 0">
      <OrderDetail orderId={orderId} supportEmail={supportEmail} />
    </PageContainer>
  );
}
