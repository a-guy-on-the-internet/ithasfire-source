"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";

/**
 * Identifies the entity that owns the page the blocks are rendered on.
 *
 * Some blocks need to act on the owner — e.g. `request_to_play` submits a
 * booking request *to* the place that owns the page. The owner summary is only
 * available at the page level (`PublicPageData.entity`), so
 * `EntityPageContent` provides it here for any block that needs it.
 *
 * Defaults to `null` (no provider / non-place owners), so blocks must handle
 * the absent case.
 */
export type BlockPageOwner = {
  /**
   * Set when the page is owned by a PLACE.
   *
   * `acceptsRequests` mirrors `placeAcceptsBookingRequests(entity)` (VERIFIED +
   * opted-in) so in-column blocks can surface the in-app booking-request CTA on
   * the same gate the hero button uses, without re-deriving it.
   */
  place: {
    id: string;
    name: string;
    acceptsRequests: boolean;
    /**
     * `page.slug` — the public route the blocks are rendered under. The
     * `track_record` block links to `/p/{pageSlug}/acts` and needs the slug
     * the reader arrived on, which only the page level holds.
     */
    pageSlug: string;
    /**
     * The anonymous, cache-safe arrival areas the server rendered (see
     * `EntityPageShell`), for the freeform `location_map` block.
     */
    arrivalAreas?: VisibleArrivalArea[];
    /** The page editor: skip the viewer's own arrival-area probe. */
    publicPreview?: boolean;
  } | null;
};

const BlockPageOwnerContext = createContext<BlockPageOwner | null>(null);

export function BlockPageOwnerProvider({
  owner,
  children,
}: {
  owner: BlockPageOwner;
  children: ReactNode;
}) {
  return (
    <BlockPageOwnerContext.Provider value={owner}>
      {children}
    </BlockPageOwnerContext.Provider>
  );
}

export function useBlockPageOwner(): BlockPageOwner | null {
  return useContext(BlockPageOwnerContext);
}
