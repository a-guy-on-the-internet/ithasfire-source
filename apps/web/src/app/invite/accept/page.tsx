import type { Metadata } from "next";
import { AcceptInvitation } from "./_components/AcceptInvitation";

export const metadata: Metadata = {
  title: "Accept Invitation",
};

type Props = {
  searchParams: Promise<{ token?: string }>;
};

export default async function AcceptInvitationPage({ searchParams }: Props) {
  const params = await searchParams;
  const token = params.token ?? null;

  return <AcceptInvitation token={token} />;
}
