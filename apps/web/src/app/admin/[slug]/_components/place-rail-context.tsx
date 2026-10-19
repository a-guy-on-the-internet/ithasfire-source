"use client";

import { useMemo } from "react";

import type { NavigationRailBack } from "@th/ui";

import { trpc } from "@/trpc";

import type {
  AdminRailContext,
  AdminRailContextDeps,
} from "./admin-context-registry";
import {
  buildPlaceNavSections,
  type PlaceAdminPathContext,
} from "./place-nav-sections";
import { PlaceRailContextHeader } from "./PlaceRailContextHeader";

/**
 * The place surfaces warmed on context entry (rail clicks feel like tabs).
 * `edit` and `verify` are redirectors to `settings` now (FR-401) — warming
 * them would prefetch a redirect.
 */
const PLACE_PREFETCH_SEGMENTS = [
  "settings",
  "page",
  "layout",
  "calendar",
  "bookings",
  "volunteers",
] as const;

/**
 * Place-context rail descriptor hook (place-admin-rail-context FR-202). On
 * `/admin/[slug]/places/[placeId]/*` (not the list, not `/places/new`) the
 * rail shows place context: "← All places" back slot, place name +
 * verification chip, and the Venue/Operate groups from
 * `buildPlaceNavSections`.
 *
 * Structural mirror of `useEventRailContext`, minus what place context does
 * not have: no rbac/status gating on items (D4 — place access is boolean
 * ownership), and no `interceptRouteSelect` (every item is a real route; no
 * scroll anchors in v1 per D3).
 *
 * Registered on ADMIN_CONTEXT_REGISTRY; called unconditionally on every
 * AdminShell render with the parsed place path (or null off place routes) —
 * the title query stays disabled while unmatched.
 */
export function usePlaceRailContext(
  placeContext: PlaceAdminPathContext | null,
  deps: AdminRailContextDeps,
): AdminRailContext | null {
  const { slug, persistKeyBase, router, t } = deps;

  // Light title + verification for the context header (D5/NFR-1): the shell
  // never fetches the heavy getPlaceForEdit payload. Same query + key the
  // [placeId] layout primes for its document title — React Query dedupes.
  const placeTitleQuery = trpc.places.getPlaceTitle.useQuery(
    { placeId: placeContext?.placeId ?? "" },
    { enabled: Boolean(placeContext), staleTime: 60_000 },
  );

  // FR-302: the Settings item's danger/badge dress (it inherited Verification's
  // when the two merged, FR-401) follows the SAME light
  // query that feeds the header chip — no extra fetch. While the title is in
  // flight the item renders plain, then picks up the badge when data lands.
  const verification = placeTitleQuery.data?.verification;
  const sections = useMemo(() => {
    if (!placeContext) return null;
    return buildPlaceNavSections({
      placeId: placeContext.placeId,
      verification,
      t,
    });
  }, [placeContext, verification, t]);

  const placesListHref = `/admin/${slug}/places`;
  const railBack = useMemo<NavigationRailBack>(
    () => ({
      label: String(t("admin.plNavAllPlaces")),
      href: placesListHref,
      onPress: () => router.push(placesListHref),
    }),
    [placesListHref, router, t],
  );

  const railContextHeader = useMemo(() => {
    if (!placeContext) return undefined;
    const data = placeTitleQuery.data;
    // Undefined while unresolved — the rail simply omits the header row until
    // the title lands (same progressive fill as the event context).
    if (!data) return undefined;
    return (
      <PlaceRailContextHeader
        name={data.name}
        verification={data.verification}
      />
    );
  }, [placeContext, placeTitleQuery.data]);

  // Keyed on the place ID — not the match object, which is fresh per pathname
  // — so navigating between one place's surfaces never refires the shell's
  // prefetch effect.
  const placeId = placeContext?.placeId ?? null;
  const prefetchRoutes = useMemo(() => {
    if (!placeId) return null;
    const base = `/admin/${slug}/places/${placeId}`;
    return PLACE_PREFETCH_SEGMENTS.map((segment) => `${base}/${segment}`);
  }, [placeId, slug]);

  // FR-202: place context keeps its own collapse state per place id — same
  // key shape as the event context (`{base}:event:{id}`).
  const persistKey = placeId ? `${persistKeyBase}:place:${placeId}` : null;

  // Memoized so unrelated shell re-renders keep a stable context identity —
  // shell consumers (e.g. the SCAN center-action gate) dep on the object.
  return useMemo(() => {
    if (!sections || !persistKey || !prefetchRoutes) return null;
    return {
      descriptorId: "place",
      sections,
      railBack,
      railContextHeader,
      persistKey,
      prefetchRoutes,
    };
  }, [sections, railBack, railContextHeader, persistKey, prefetchRoutes]);
}
