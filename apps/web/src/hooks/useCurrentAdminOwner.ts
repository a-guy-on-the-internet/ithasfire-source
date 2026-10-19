"use client";

import { useMemo } from "react";

import {
  useEventOwnerEntities,
  type OwnerEntityWithSlug,
} from "./useEventOwnerEntities";
import { normalizeAdminSlug } from "./useAdminSlug";

/**
 * Resolves the current admin owner entity from the URL slug.
 *
 * This was previously duplicated across 6+ admin page components.
 * Centralising it avoids subtle drift (e.g. DashboardContent had its own
 * slightly different resolution logic).
 */
export function useCurrentAdminOwner(slug: string) {
  const ownerEntities = useEventOwnerEntities();
  const normalizedSlug = useMemo(() => normalizeAdminSlug(slug), [slug]);

  const currentOwner = useMemo<OwnerEntityWithSlug | null>(() => {
    if (!ownerEntities.ownersWithSlugs) return null;
    return (
      ownerEntities.ownersWithSlugs.find((o) => {
        if (normalizeAdminSlug(o.adminSlug) === normalizedSlug) return true;
        if (
          o.kind === "human" &&
          normalizeAdminSlug(`@${o.humanId}`) === normalizedSlug
        )
          return true;
        return false;
      }) ?? null
    );
  }, [ownerEntities.ownersWithSlugs, normalizedSlug]);

  return {
    currentOwner,
    normalizedSlug,
    isLoading: ownerEntities.isLoading,
    isError: ownerEntities.isError,
    ownerEntities,
  };
}
