import { RefundRequest } from "./_components/RefundRequest";

interface RefundPageProps {
  params: Promise<{ orderId: string }>;
}

export default async function RefundPage({ params }: RefundPageProps) {
  const { orderId } = await params;
  return <RefundRequest orderId={orderId} />;
}
