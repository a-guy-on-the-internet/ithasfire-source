import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { AskManageView } from "./_components/AskManageView";

type PageProps = {
  params: Promise<{ slug: string; askId: string }>;
};

export default async function AskManagePage({ params }: PageProps) {
  const { slug, askId } = await params;
  return (
    <AdminEmailVerificationGate mode="block">
      <AskManageView slug={slug} askId={askId} />
    </AdminEmailVerificationGate>
  );
}
