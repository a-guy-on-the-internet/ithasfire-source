import { redirect } from "next/navigation";

import { placeSettingsHref } from "../settings/_lib/settings-href";

/**
 * `/admin/:slug/places/:placeId/verify` is a pure redirector (FR-401). The
 * verification workflow — queue position, reviewer notes, withdraw and the
 * document upload — renders IN FULL as the Verification section of the venue
 * settings page, so this lands there scrolled to it (`#verification`). The
 * settings page applies the fragment itself once its sections have rendered.
 */
type PageProps = {
  params: Promise<{ slug: string; placeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPlaceVerifyRedirect({
  params,
  searchParams,
}: PageProps) {
  const { slug, placeId } = await params;
  redirect(
    placeSettingsHref({
      slug,
      placeId,
      searchParams: await searchParams,
      section: "verification",
    }),
  );
}
