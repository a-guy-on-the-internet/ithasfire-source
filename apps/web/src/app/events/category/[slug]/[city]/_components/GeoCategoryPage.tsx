"use client";

import { useCallback } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";

import {
  Text,
  EventGrid,
  type EventSummary,
  Button,
  useLocale,
  useTranslations,
} from "@th/ui";

import { useSavedEventSummaries } from "@/components/saves/useEventSaves";
import { usePublicLinks } from "@/i18n/use-public-links";
import { categoryDisplayName } from "@/lib/category-display-name";

// ── Layout ───────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  name: "GeoCategoryPageContainer",
  width: "100%",
  maxWidth: 1200,
  marginHorizontal: "auto",
  paddingHorizontal: "$4",
  paddingVertical: "$6",
  gap: "$5",
});

const HeaderColumn = styled(YStack, {
  paddingBottom: "$3",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  gap: "$2",
});

// ── Component ────────────────────────────────────────────────────────────────

interface GeoCategoryPageProps {
  /** Server-seeded event list (already in the initial HTML for SEO). */
  events: EventSummary[];
  /** Display-cased English category label, e.g. "Open Mics". */
  categoryName: string;
  /** Every name the category has (`{ en, es? }`); absent from an older API. */
  categoryNames?: Partial<Record<string, string>>;
  /** Display city label, e.g. "Nashville". */
  cityLabel: string;
  /** Total upcoming events for this combo (drives the intro sentence). */
  count: number;
}

/**
 * Geo × category landing page body (`/events/category/<slug>/<city>`).
 *
 * Renders from server-seeded props — NOT a tRPC hook — so the event list is in
 * the initial HTML for crawlers. The only client-side work is the save-heart
 * merge (viewer-specific) and card navigation.
 */
export function GeoCategoryPage({
  events,
  categoryName: englishCategoryName,
  categoryNames,
  cityLabel,
  count,
}: GeoCategoryPageProps) {
  const router = useRouter();
  const t = useTranslations();
  const locale = useLocale();
  // Home in this page's language: `/es` from the Spanish twin (FR-006).
  const homePath = usePublicLinks().path({ kind: "home" });
  // Visible text only, in the viewer's language; the route's metadata and
  // JSON-LD keep the English name (NFR-001).
  const categoryName = categoryDisplayName(
    { name: englishCategoryName, names: categoryNames },
    locale,
  );

  // Save-heart flags for the grid (one batched query per page of cards),
  // consistent with the national category page and the rest of the app.
  const { events: eventsWithSaved, onFavoriteToggle } =
    useSavedEventSummaries(events);

  const handleEventPress = useCallback(
    (event: EventSummary) => {
      if (event.slug) router.push(`/events/${event.slug}`);
    },
    [router],
  );

  return (
    <PageContainer>
      <YStack gap="$3">
        <XStack alignItems="center" gap="$2">
          <Button
            variant="ghost"
            size="$3"
            onPress={() => router.push(homePath)}
            aria-label={t("common.backToHome") as string}
          >
            {`← ${String(t("common.footerHome"))}`}
          </Button>
        </XStack>
        <HeaderColumn>
          <Text variant="h1" weight="bold">
            {String(
              t("search.categoryInCityTitle", {
                category: categoryName,
                city: cityLabel,
              }),
            )}
          </Text>
          <Text variant="body" tone="muted">
            {String(
              t("search.categoryInCityIntro", {
                count,
                // Lowercase the category so the sentence reads naturally
                // ("… upcoming open mics in Nashville …"); the heading keeps
                // its Title Case.
                category: categoryName.toLowerCase(),
                city: cityLabel,
              }),
            )}
          </Text>
        </HeaderColumn>
      </YStack>

      <EventGrid
        events={eventsWithSaved}
        variant="grid"
        minCardWidth={240}
        testIdBase="geo-category-page-events"
        onCardPress={handleEventPress}
        onFavoriteToggle={onFavoriteToggle}
        renderEmptyState={() => (
          <YStack alignItems="center" paddingVertical="$6" gap="$3">
            <Text variant="body" tone="muted" textAlign="center">
              {String(
                t("search.noEventsInCategoryCity", {
                  category: categoryName,
                  city: cityLabel,
                }),
              )}
            </Text>
            <Button size="$3" onPress={() => router.push(homePath)}>
              {String(t("common.backToHome"))}
            </Button>
          </YStack>
        )}
      />
    </PageContainer>
  );
}
