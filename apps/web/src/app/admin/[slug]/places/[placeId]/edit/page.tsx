import { redirect } from "next/navigation";

import { placeSettingsHref } from "../settings/_lib/settings-href";

/**
 * `/admin/:slug/places/:placeId/edit` is a pure redirector (FR-401). The
 * details form it rendered is the Identity and Location sections of the venue
 * settings page now — its state and save moved there with every documented
 * data-loss fix intact. Links, bookmarks and e2e specs that still say `/edit`
 * land on `/settings` with their query string.
 */
type PageProps = {
  params: Promise<{ slug: string; placeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPlaceEditRedirect({
  params,
  searchParams,
}: PageProps) {
  const { slug, placeId } = await params;
  redirect(
    placeSettingsHref({ slug, placeId, searchParams: await searchParams }),
  );
}
