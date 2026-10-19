import type { Metadata } from "next";
import { ClaimTransfer } from "./_components/ClaimTransfer";

export const metadata: Metadata = {
  title: "Claim Ticket Transfer",
};

type Props = {
  searchParams: Promise<{ token?: string }>;
};

export default async function ClaimTransferPage({ searchParams }: Props) {
  const params = await searchParams;
  const token = params.token ?? null;

  return <ClaimTransfer token={token} />;
}
