"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";

import {
  Text,
  EventGrid,
  Lineup,
  LineupRow,
  ViewToggle,
  useFormatters,
  type EventSummary,
  type ViewToggleMode,
  Button,
  listingPriceText,
  useListingPriceWords,
  useTranslations,
} from "@th/ui";

import {
  useCategoryEvents,
  useCategoryList,
  type CategoryEventsSeed,
} from "@/app/_components/home/useCategoryBrowse";
import { useSavedEventSummaries } from "@/components/saves/useEventSaves";
import { usePublicLinks } from "@/i18n/use-public-links";
import { categoryDisplayName } from "@/lib/category-display-name";
import { SaveHeart } from "@/components/saves/SaveHeart";
import { CATEGORY_PAGE_SIZE } from "@/lib/events/category-page";

import styles from "./CategoryPage.module.css";
import { toLineupWhen } from "./lineup-when";

// ── Layout ───────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  name: "CategoryPageContainer",
  width: "100%",
  maxWidth: 1200,
  marginHorizontal: "auto",
  paddingHorizontal: "$4",
  paddingVertical: "$6",
  gap: "$5",
});

const HeaderRow = styled(XStack, {
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$3",
  flexWrap: "wrap",
});

// ── Lineup date helpers live in `./lineup-when` (event-zone, SSR-safe).

// ── Component ────────────────────────────────────────────────────────────────

interface CategoryPageProps {
  categorySlug: string;
  /** English name read on the server, used until the category list loads. */
  initialCategoryName?: string;
  /**
   * Every name read on the server (`{ en, es? }`), so the heading is in the
   * viewer's language from the first paint.
   */
  initialCategoryNames?: Partial<Record<string, string>>;
  /** Server read of the first page, so the events are in the initial HTML. */
  seed?: CategoryEventsSeed | null;
}

export function CategoryPage({
  categorySlug,
  initialCategoryName,
  initialCategoryNames,
  seed,
}: CategoryPageProps) {
  const router = useRouter();
  const t = useTranslations();
  // Home in this page's language: `/es` from the Spanish twin (FR-006).
  const homePath = usePublicLinks().path({ kind: "home" });
  // Row prices in the viewer's language; "See details" when there is none.
  const priceWords = useListingPriceWords();
  const { locale } = useFormatters();

  // The list's names are already in the viewer's language; the server's are
  // picked here with the same locale, so both renders agree.
  const { categories } = useCategoryList();
  const categoryName =
    categories.find((c) => c.slug === categorySlug)?.name ??
    (initialCategoryName
      ? categoryDisplayName(
          { name: initialCategoryName, names: initialCategoryNames },
          locale,
        )
      : categorySlug);

  const { events, isLoading } = useCategoryEvents(
    categorySlug,
    CATEGORY_PAGE_SIZE,
    null,
    seed,
  );
  // Save-heart flags for the list/grid (one batched query per page of events).
  const { events: eventsWithSaved, onFavoriteToggle } =
    useSavedEventSummaries(events);

  // Catalog pages default to the text-first lineup (v2 renderer C); grid stays
  // available for the image-led browse.
  const [viewMode, setViewMode] = useState<ViewToggleMode>("list");

  const handleEventPress = useCallback(
    (event: EventSummary) => {
      if (event.slug) router.push(`/events/${event.slug}`);
    },
    [router],
  );

  const lineupRows = useMemo(
    () =>
      eventsWithSaved.map((event) => ({
        event,
        // Both renderings exist in the markup (CSS picks one), so both sets
        // of labels are computed: the compact one drops the weekday. Read in
        // the event's zone, so the server renders the real labels (no blank
        // placeholder swapped after hydration).
        when: toLineupWhen(event, locale, false),
        whenCompact: toLineupWhen(event, locale, true),
      })),
    [eventsWithSaved, locale],
  );

  // Hold the category column open only if something in this page of results
  // will fill it — an always-reserved track is 110px taken off every title.
  const hasCategories = useMemo(
    () => eventsWithSaved.some((event) => Boolean(event.tags?.length)),
    [eventsWithSaved],
  );

  const hasEvents = !isLoading && eventsWithSaved.length > 0;
  const showList = viewMode === "list" && hasEvents;

  const emptyState = (
    <YStack alignItems="center" paddingVertical="$6" gap="$3">
      <Text variant="body" tone="muted" textAlign="center">
        {String(t("search.noEventsInCategory"))}
      </Text>
      <Button size="$3" onPress={() => router.push(homePath)}>
        {String(t("common.backToHome"))}
      </Button>
    </YStack>
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
        <HeaderRow
          paddingBottom="$3"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
        >
          {/* Visual h2 scale, but this is the page's only heading — tag="h1"
              keeps the document ladder intact. */}
          <Text variant="h2" tag="h1" weight="bold">
            {categoryName}
          </Text>
          <ViewToggle value={viewMode} onChange={setViewMode} />
        </HeaderRow>
      </YStack>

      {showList ? (
        <Lineup role="list">
          {lineupRows.map(({ event, when, whenCompact }) => {
            const rowProps = {
              name: event.title,
              subtitle: event.venue || undefined,
              category: event.tags?.[0],
              reserveCategory: hasCategories,
              price:
                listingPriceText(event, priceWords) ??
                (event.priceLabel ? priceWords.seeDetails : undefined),
              // Real anchor (not onPress) — a browse catalog wants
              // cmd/middle-click-to-open-in-new-tab link semantics, and it
              // avoids the double-nav of href + a same-URL router.push.
              href: event.slug ? `/events/${event.slug}` : undefined,
            };
            return (
              // SaveHeart is a SIBLING overlay of the row anchor — a <button>
              // inside an <a> is invalid HTML.
              <YStack key={event.id} position="relative" role="listitem">
                {/* Wide and compact rows both render; CategoryPage.module.css
                    shows one by viewport width, so the server's first paint is
                    already right at 320px (no hook, no post-hydration jump). */}
                <div className={styles.wide}>
                  <LineupRow
                    {...rowProps}
                    dateLabel={when.dateLabel}
                    timeLabel={when.timeLabel}
                    paddingRight={52}
                    testId={`category-lineup-${event.id}`}
                  />
                </div>
                <div className={styles.narrow}>
                  <LineupRow
                    {...rowProps}
                    dateLabel={whenCompact.dateLabel}
                    timeLabel={whenCompact.timeLabel}
                    compact
                    // Reserve room for the absolutely-placed save heart. Tighter
                    // on compact: at 320px the row is already spending 72px on
                    // the date rail, and every pixel of gutter comes straight
                    // out of the title — 52px here is what broke "WAREHOUSE"
                    // across two lines. 28px still clears the ~24px glyph at
                    // right:4.
                    paddingRight={28}
                    testId={`category-lineup-compact-${event.id}`}
                  />
                </div>
                <SaveHeart
                  saved={Boolean(event.favorite)}
                  onToggle={() => onFavoriteToggle(event.id)}
                  testId={`category-lineup-${event.id}-save`}
                  style={{
                    position: "absolute",
                    top: "50%",
                    right: 4,
                    transform: "translateY(-50%)",
                  }}
                />
              </YStack>
            );
          })}
        </Lineup>
      ) : (
        <EventGrid
          events={eventsWithSaved}
          loading={isLoading}
          variant="grid"
          minCardWidth={240}
          testIdBase="category-page-events"
          onCardPress={handleEventPress}
          onFavoriteToggle={onFavoriteToggle}
          renderEmptyState={() => emptyState}
        />
      )}
    </PageContainer>
  );
}
