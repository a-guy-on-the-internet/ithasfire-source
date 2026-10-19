import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { PlaceVolunteersView } from "./_components/PlaceVolunteersView";

type PageProps = {
  params: Promise<{ slug: string; placeId: string }>;
};

export default async function PlaceVolunteersPage({ params }: PageProps) {
  const { slug, placeId } = await params;
  return (
    <AdminEmailVerificationGate mode="block">
      <PlaceVolunteersView slug={slug} placeId={placeId} />
    </AdminEmailVerificationGate>
  );
}
