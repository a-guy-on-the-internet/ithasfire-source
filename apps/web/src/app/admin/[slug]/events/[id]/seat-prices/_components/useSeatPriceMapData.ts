"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";

import { trpc } from "@/trpc";

import {
  SeatGlyphFileError,
  approximateMapSeats,
  glyphFileKey,
  pickMapLayoutId,
  readSeatGlyphFile,
  resolveMapSeats,
  type MapSeat,
  type PublicPlaceLayout,
  type SeatGlyph,
} from "./seat-price-map-model";
import type { SeatPriceModel } from "./seat-price-model";

/**
 * Where the seats on the map come from:
 * - `exact`: the layout's glyph file, so every seat is where it is;
 * - `none`: the layout has no saved seat positions, so seats are laid out in
 *   rows inside their sections (`approximateMapSeats`);
 * - `failed`: the glyph file did not load or could not be read; the same
 *   rows are drawn, and the map says so and offers Retry.
 */
export type SeatPositions = "exact" | "none" | "failed";

export type SeatPriceMapData =
  | { status: "noLayout" }
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | {
      status: "ready";
      layout: PublicPlaceLayout;
      seats: MapSeat[];
      positions: SeatPositions;
      retryPositions: () => void;
    };

/**
 * The glyph link is signed for an hour (`getGlyphUrl`, `expiresSec: 3600`).
 * A layout read older than this is read again before its link is used, so a
 * link handed to `fetch` always has at least half an hour left.
 */
const LAYOUT_FRESH_MS = 30 * 60_000;
/** Parsed glyphs outlive a List/Map switch and a re-signed link. */
const GLYPHS_KEPT_MS = 60 * 60_000;

/** The parsed glyph file, cached by layout and by file, never by link. */
export function seatGlyphsQueryKey(layoutId: string, fileKey: string) {
  return ["admin.seat-prices.glyphs", layoutId, fileKey] as const;
}

/** Fetch and read a glyph file. Every failure is reported, then thrown. */
export async function fetchSeatGlyphs(
  url: string,
  layoutId: string,
): Promise<SeatGlyph[]> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Seat glyphs: HTTP ${response.status}`);
    return readSeatGlyphFile(await response.json());
  } catch (error: unknown) {
    try {
      Sentry.captureException(error, {
        tags: { area: "admin.seat-prices.map", kind: "glyph-fetch" },
        extra: {
          placeLayoutId: layoutId,
          ...(error instanceof SeatGlyphFileError ? { entries: error.entries } : {}),
        },
      });
    } catch {
      // Reporting is best-effort; the map says the positions did not load.
    }
    throw error;
  }
}

/**
 * The layout and its seat glyphs, read the way the buyer's seat map reads
 * them: `placeLayouts.getPublicPlaceLayout` by the layout id the seat price
 * read gives each section, then the glyph file from its signed URL. The
 * public read is used because the admin one (`getPlaceLayout`) admits only
 * the PLACE's owners, and an organizer renting a room is not one.
 */
export function useSeatPriceMapData(model: SeatPriceModel): SeatPriceMapData {
  const queryClient = useQueryClient();
  const layoutId = pickMapLayoutId(model);
  const layoutQuery = trpc.placeLayouts.getPublicPlaceLayout.useQuery(
    { placeLayoutId: layoutId ?? "", includeGlyphs: true },
    {
      enabled: layoutId !== null,
      staleTime: LAYOUT_FRESH_MS,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  );
  const layout = layoutQuery.data?.layout ?? null;
  const glyphUrl = layout?.glyphBlobUrl ?? null;
  const loadedLayoutId = layout?.id ?? null;
  const fileKey = glyphUrl ? glyphFileKey(glyphUrl) : null;

  const glyphQuery = useQuery({
    queryKey: seatGlyphsQueryKey(loadedLayoutId ?? "", fileKey ?? ""),
    queryFn: () => fetchSeatGlyphs(glyphUrl as string, loadedLayoutId as string),
    // While the layout is being read again its link may be the stale one:
    // wait for the fresh link rather than fetch a dead one.
    enabled: Boolean(glyphUrl && loadedLayoutId) && !layoutQuery.isFetching,
    staleTime: Infinity,
    gcTime: GLYPHS_KEPT_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Retry asks for a freshly signed link first: the old one may have expired,
  // and fetching it again would fail the same way.
  const refetchLayout = layoutQuery.refetch;
  const retryPositions = useCallback(() => {
    void (async () => {
      const fresh = await refetchLayout();
      const next = fresh.data?.layout;
      if (!next?.glyphBlobUrl) return;
      const url = next.glyphBlobUrl;
      await queryClient
        .fetchQuery({
          queryKey: seatGlyphsQueryKey(next.id, glyphFileKey(url)),
          queryFn: () => fetchSeatGlyphs(url, next.id),
          staleTime: 0,
          gcTime: GLYPHS_KEPT_MS,
          retry: false,
        })
        .catch(() => {
          // Already reported; the query's error state shows the notice.
        });
    })();
  }, [queryClient, refetchLayout]);

  const glyphs = glyphUrl ? (glyphQuery.data ?? null) : null;
  const glyphFailed = Boolean(glyphUrl) && glyphQuery.isError && !glyphQuery.data;
  const positions: SeatPositions =
    glyphs && glyphs.length > 0 ? "exact" : glyphFailed ? "failed" : "none";
  const seats = useMemo(() => {
    if (!layout) return [];
    if (glyphs && glyphs.length > 0) return resolveMapSeats(model, layout.id, glyphs);
    return approximateMapSeats(model, layout.id, layout.sections);
  }, [glyphs, layout, model]);

  if (layoutId === null) return { status: "noLayout" };
  if (!layout) {
    return layoutQuery.isError
      ? { status: "failed", retry: () => void layoutQuery.refetch() }
      : { status: "loading" };
  }
  if (glyphUrl && !glyphQuery.data && !glyphFailed) return { status: "loading" };
  return { status: "ready", layout, seats, positions, retryPositions };
}
