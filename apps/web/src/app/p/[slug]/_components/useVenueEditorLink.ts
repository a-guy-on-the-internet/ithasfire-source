"use client";

import { useMemo } from "react";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { moderatorPlacePageHref } from "@/lib/places/moderator-place-page-href";

/**
 * Resolves the signed-in viewer's editor link for a venue, or `null`.
 *
 * Ownership is proven SERVER-side: `places.getPlaceForEdit` throws for
 * non-owners (`retry: false`, so a rejection just yields `null`). The owning
 * entity's admin slug comes from intersecting the place's access list with the
 * orgs/humans the viewer manages, which is what turns "may edit" into a real
 * `/admin/{slug}/places/{placeId}/page` URL. Anonymous viewers fire neither
 * query.
 *
 * WHY A HOOK AND NOT A COMPONENT: the venue page renders this affordance in
 * two places — a visible chip in the hero action row on wide viewports, and an
 * item inside the `⋯` overflow menu on phones (only one of the two is ever in
 * the accessibility tree; the swap is a CSS media query, not a JS branch).
 * Both need the same answer to the same question, and both must get it from
 * ONE pair of requests: React Query dedupes by query key, so the second caller
 * of an identical `useQuery` reads the first one's cache entry rather than
 * issuing a second fetch.
 */
export function useVenueEditorLink(placeId: string): {
  /**
   * `/admin/{slug}/places/{id}/page` for an owner, the moderator route for a
   * community moderator on an unowned place, or `null`.
   */
  href: string | null;
} {
  const { data: session, isPending } = authClient.useSession();
  const isSignedIn = Boolean(session?.user);

  const editQuery = trpc.places.getPlaceForEdit.useQuery(
    { placeId },
    {
      retry: false,
      staleTime: 60_000,
      enabled: isSignedIn && !isPending,
    },
  );

  // CHAINED, not parallel. This runs on a hot public surface, so a signed-in
  // attendee browsing any venue must not pay for the owner-entities list they
  // will never use: `getPlaceForEdit` throws for non-owners, so gating on its
  // success means only an actual owner ever fires the second request. The
  // owner path is unaffected — the intersection below needs BOTH results
  // anyway, so it was already waiting on this one.
  const { ownersWithSlugs } = useEventOwnerEntities({
    enabled: editQuery.isSuccess,
  });

  const editSlug = useMemo(() => {
    const access = editQuery.data?.place.access;
    if (!access || !ownersWithSlugs) return null;

    const orgMatch = ownersWithSlugs.find(
      (owner) => owner.kind === "org" && access.orgIds.includes(owner.orgId),
    );
    if (orgMatch) return orgMatch.adminSlug;

    const humanMatch = ownersWithSlugs.find(
      (owner) =>
        owner.kind === "human" && access.humanIds.includes(owner.humanId),
    );
    return humanMatch?.adminSlug ?? null;
  }, [editQuery.data, ownersWithSlugs]);

  // Not an owner: is the viewer a community moderator at all? One cached
  // answer per session (the same query and staleTime /moderate's shell and
  // `use-date-moderation` use), so an ordinary signed-in visitor sends this
  // once, not a place probe on every place page. It answers `allowed` on the
  // ROLE alone (`allowWithoutSecondFactor`), so a moderator without a second
  // factor still reaches the probe below.
  const roleQuery = trpc.community.checkModeratorAccess.useQuery(undefined, {
    enabled: isSignedIn && !isPending && editQuery.isError,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    meta: { silent: true },
  });

  // A moderator: may they edit THIS place's page (an unowned, ACTIVE place;
  // moderator-place-page D8)? Advisory only: every write re-checks under the
  // claim lock.
  const moderatorQuery = trpc.entityPages.placePageEditAccess.useQuery(
    { placeId },
    {
      retry: false,
      staleTime: 60_000,
      enabled: roleQuery.data?.allowed === true,
      meta: { silent: true },
    },
  );
  const moderatorAccess = moderatorQuery.data;
  // SECOND_FACTOR_REQUIRED gives no link: the role check runs before the
  // ownership check, so that answer says nothing about THIS place, and a link
  // on an owned place would offer an editor that can never open.
  const canModerate =
    moderatorAccess?.canEditPage === true &&
    moderatorAccess.editorKind === "community_moderator";

  // Owner (with a resolved admin slug) → their admin editor; a moderator →
  // the moderator route; anyone else → no link.
  const href =
    editQuery.isSuccess && editSlug
      ? `/admin/${editSlug}/places/${placeId}/page`
      : canModerate
        ? moderatorPlacePageHref(placeId)
        : null;

  return { href };
}
