import type { Metadata } from "next";

import { Transfer } from "./_components/Transfer";

export const metadata: Metadata = {
  title: "Transfer Ticket",
};

type PageProps = {
  params: Promise<{ orderId: string }>;
};

export default async function TransferPage({ params }: PageProps) {
  const { orderId } = await params;
  return <Transfer orderId={orderId} />;
}
