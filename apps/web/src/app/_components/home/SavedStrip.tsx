"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventSummary } from "@th/ui";
import { useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useEventSaves } from "@/components/saves/useEventSaves";
import { HomeEventSection } from "./HomeEventSection";
import { ViewAllLink } from "./ViewAllLink";
import { formatSavedEventDate } from "./saved-strip-date";

const STRIP_LIMIT = 12;

/**
 * Signed-in carousel of the viewer's saved upcoming events on the home
 * surface (discovery flow's saved_strip). Renders nothing when signed out or
 * when the watchlist is empty — the strip is a shortcut, not a nag.
 *
 * Saves are private: this only ever shows the viewer's own list, no counts.
 */
export function SavedStrip() {
  const t = useTranslations();
  const fmt = useFormatters();

  // The Better Auth session resolves client-side, so on the server (and the
  // first client render) it's absent while the client can rehydrate a cached
  // user synchronously. Gating `isSignedIn` on `hasMounted` keeps this strip
  // rendered as `null` on the server AND the first client render, so it can't
  // shift sibling home sections and trip a hydration mismatch. Same pattern as
  // AppNavbar. The strip reveals right after mount.
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);

  const sessionQuery = authClient.useSession();
  const isSignedIn = hasMounted && Boolean(sessionQuery.data?.user);

  const savedQuery = trpc.eventSaves.listMine.useQuery(
    { scope: "upcoming", limit: STRIP_LIMIT },
    {
      enabled: isSignedIn,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  const items = useMemo(
    () => savedQuery.data?.items ?? [],
    [savedQuery.data?.items],
  );

  // No id list: the strip already knows everything here is saved, so it
  // skips the batched saved-state query and only uses the toggle.
  const { toggleSave } = useEventSaves([]);

  const events = useMemo<EventSummary[]>(
    () =>
      items.map((item) => ({
        id: item.event.id,
        title: item.event.title,
        date: formatSavedEventDate(
          fmt.dateTime,
          item.event.startsAt,
          item.event.timezone,
        ),
        venue:
          item.event.locationLabel ??
          item.event.addressText ??
          String(t("saves.venueTba")),
        priceLabel: "",
        slug: item.event.slug,
        // Same media convention as the discovery DTO mappers: url + title alt.
        media: item.event.heroImageUrl
          ? { url: item.event.heroImageUrl, alt: item.event.title }
          : undefined,
        // Everything in the strip is saved by definition.
        favorite: true,
        badge:
          item.event.status === "CANCELLED"
            ? { text: String(t("saves.cancelledBadge")), tone: "cold" as const }
            : undefined,
      })),
    [fmt, items, t],
  );

  // The strip only shows saved events, so the heart is an unsave-only quick
  // action — the card leaves the strip once the list refetches.
  const handleFavoriteToggle = useCallback(
    (eventId: string) => toggleSave(eventId, false),
    [toggleSave],
  );

  // Signed out, still resolving, errored, or nothing saved → no strip.
  if (!isSignedIn || savedQuery.isError || (!savedQuery.isLoading && events.length === 0)) {
    return null;
  }

  return (
    <HomeEventSection
      title={String(t("saves.homeStripTitle"))}
      events={events}
      loading={savedQuery.isLoading}
      variant="carousel"
      testIdBase="home-saved-strip"
      headerAction={<ViewAllLink href="/saved" />}
      onFavoriteToggle={handleFavoriteToggle}
    />
  );
}

SavedStrip.displayName = "SavedStrip";
