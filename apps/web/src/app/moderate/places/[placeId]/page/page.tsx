import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ModeratorPlacePageEditor } from "./_components/ModeratorPlacePageEditor";

export const metadata: Metadata = {
  title: "Edit place page",
  description: "Edit the page of a place nobody has claimed yet.",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/moderate/places/[placeId]/page` — a community moderator edits the page of
 * an unowned place (moderator-place-page spec D8, FR-008).
 *
 * It lives under /moderate, not /admin/{slug}, because a moderator holds no
 * admin slug for a place nobody owns. ACCESS is inherited from the /moderate
 * gates (edge middleware, `moderate/layout.tsx`, `ModerateShell`: moderator
 * role plus a second factor). What this route adds is the PLACE-scoped answer
 * from `entityPages.placePageEditAccess`: owned, claim pending, archived and
 * the rest each get their own state instead of an editor whose every save
 * would be refused. Entry points: the place page's "Edit page" action and the
 * place panel on /platform/places.
 */
export default async function ModeratePlacePagePage({
  params,
}: {
  params: Promise<{ placeId: string }>;
}) {
  const { placeId } = await params;
  // The probe's input is `z.string().uuid()`; a junk segment never reaches it.
  if (!UUID_RE.test(placeId)) {
    notFound();
  }
  return <ModeratorPlacePageEditor placeId={placeId} />;
}
