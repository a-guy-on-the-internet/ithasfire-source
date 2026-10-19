"use client";

import { memo, useCallback, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";

import {
  Chip,
  Text,
  ViewToggle,
  type EventSummary,
  type ViewToggleMode,
  EventGrid,
  useTranslations,
} from "@th/ui";

import { useSavedEventSummaries } from "@/components/saves/useEventSaves";
import { categoryLinkSlugs } from "@/i18n/public-paths";
import { usePublicLinks } from "@/i18n/use-public-links";

import {
  useBrowseCategoryList,
  useCategoryEvents,
  type CategoryItem,
} from "./useCategoryBrowse";
import { ViewAllLink } from "./ViewAllLink";

// ── Styled containers ────────────────────────────────────────────────────────

const SectionContainer = styled(YStack, {
  name: "CategoryBrowseSection",
  // The container's own `gap` never reached the header / chips / grid: all
  // three sit inside ONE positioned child (the zIndex wrapper below), so the
  // vertical rhythm is set explicitly on the inner blocks instead —
  // header → chips $4 (16px), chips → grid $5 (24px). See `CategoryRow` and
  // the grid wrapper.
  // Swiss structural rule: visible top-edge line between content sections
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  paddingTop: "$4",
  // `position: relative` is the containing block for the .swiss-dots
  // pseudo-element. No `overflow: hidden` here: the pseudo is
  // `position: absolute; inset: 0`, so it is ALREADY constrained to this
  // element's padding box — the clip bought nothing and cut the 4px offset
  // shadow off the grid's rightmost column and bottom row (v2 --shadow-card).
  position: "relative",
});

const SectionHeader = styled(XStack, {
  name: "CategoryBrowseHeader",
  alignItems: "center",
  justifyContent: "space-between",
  // Without wrap, title + (toggle + view-all) overflow the mobile viewport.
  flexWrap: "wrap",
  gap: "$3",
});

const CategoryRow = styled(XStack, {
  name: "CategoryRow",
  // Chips WRAP — never a horizontal drag rail (D-138). The old `ScrollView`
  // hid "Comedy…" off the right edge of a 390px phone with no affordance, and
  // its 20px content padding was the only thing keeping the first chip off the
  // viewport edge; the section already sits on the shell gutter, so a wrapped
  // row needs no horizontal padding of its own.
  flexWrap: "wrap",
  gap: "$2",
  // 16px below the header cluster (title block, or the wrapped toggle +
  // VIEW ALL line on a phone), so the selected chip no longer kisses the
  // toggle's bottom edge.
  marginTop: "$4",
});

// ── Category chip ────────────────────────────────────────────────────────────

interface CategoryChipProps {
  category: CategoryItem;
  selected: boolean;
  onSelect: (slug: string) => void;
}

const CategoryChip = memo(function CategoryChip({
  category,
  selected,
  onSelect,
}: CategoryChipProps) {
  if (selected) {
    return (
      // Selected = deep-accent fill. The 13px label is small text, so the 4.5:1
      // floor applies, not AA-large: `info`/`filled` resolves to the
      // `$accentHard` fill (#B93312 on Stub — the exact fill v2 §3 prescribes
      // for small-text-on-accent) with `$onStructure`, i.e. 5.68:1 on Stub and
      // 9.46:1 on swiss/ember. It used to paint `$background` on the lighter
      // `$accent` #E2481D = 3.57:1 (FAIL). Both halves come from
      // intentVisualConfigs.info — do not re-point the fill here without moving
      // the foreground with it. The unselected branch below deliberately has NO
      // hover fill; see its note.
      <Chip
        tone="info"
        variant="filled"
        size="md"
        interactive
        onPress={() => onSelect(category.slug)}
        role="tab"
        aria-selected
      >
        {category.name}
      </Chip>
    );
  }

  return (
    <Chip
      tone="neutral"
      variant="outline"
      size="md"
      interactive
      onPress={() => onSelect(category.slug)}
      role="tab"
      aria-selected={false}
      backgroundColor="$surfaceMuted"
      borderColor="$borderColor"
      // v2 .chip:hover = accent border + ink text, background UNCHANGED.
      // Do not add a hover fill here: Chip passes tone/variant's textColor as
      // an explicit `color` prop on the inner Text, so the label cannot react
      // to hover. A `$surfaceStrong` fill resolves to ink (#211C16) on Stub —
      // the same value as the neutral/outline label — and the chip's text
      // vanished into a solid black rectangle at 1.00:1 contrast.
      hoverStyle={{
        borderColor: "$accent",
      }}
    >
      {category.name}
    </Chip>
  );
});

// ── Main section ─────────────────────────────────────────────────────────────

interface CategoryBrowseSectionProps {
  /** User coordinates for geo-ranked results. */
  coords?: { lat: number; lng: number } | null;
  /**
   * Page-global ordinal for the numbered kicker (zero-padded like the
   * sibling HomeEventSection). Falls back to the "—" placeholder when
   * absent.
   */
  sectionNumber?: number;
}

/**
 * Wrapping category chips + a grid of events for the selected category.
 * Tapping a chip loads that category's events in place. Tapping "View All"
 * navigates to the full category browse page.
 */
export const CategoryBrowseSection = memo(function CategoryBrowseSection({
  coords,
  sectionNumber,
}: CategoryBrowseSectionProps) {
  const router = useRouter();
  const t = useTranslations();
  // Only categories whose page lists something (owner ruling 2026-10-14), so
  // no chip opens an empty grid.
  const { categories, isLoading: catsLoading } = useBrowseCategoryList();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewToggleMode>("grid");

  // Default to first category once loaded; a tapped one that a refetch
  // dropped falls back to the first too.
  const activeSlug =
    selectedSlug && categories.some((c) => c.slug === selectedSlug)
      ? selectedSlug
      : (categories[0]?.slug ?? null);
  const activeCategory = categories.find((c) => c.slug === activeSlug);
  // "View all" opens the category page in this page's language (FR-006).
  const links = usePublicLinks();

  const { events, isLoading: eventsLoading } = useCategoryEvents(
    activeSlug,
    8,
    coords,
  );
  // Save-heart flags for the visible category grid (one batched query).
  const { events: eventsWithSaved, onFavoriteToggle } =
    useSavedEventSummaries(events);

  const handleSelect = useCallback((slug: string) => {
    setSelectedSlug(slug);
  }, []);

  const handleEventPress = useCallback(
    (event: EventSummary) => {
      if (event.slug) router.push(`/events/${event.slug}`);
    },
    [router],
  );

  // Don't render until we have at least one category
  if (!catsLoading && categories.length === 0) return null;

  return (
    <SectionContainer className="swiss-diagonal">
      <div style={{ position: "relative", zIndex: 1 }}>
        <SectionHeader>
          {/* `flexShrink`/`minWidth: 0` on BOTH levels, matching the sibling
              HomeEventSection. A flex child will not shrink below its content's
              intrinsic min-width, so without this the uppercase +1-tracked
              caption below set a ~346px floor and the header pushed the whole
              document to a 358px scrollWidth on a 320px viewport — a page-wide
              horizontal scrollbar sourced from this one row. */}
          <XStack gap="$2" alignItems="baseline" flexShrink={1} minWidth={0}>
            <Text
              variant="kicker"
              tone="accent"
              weight="bold"
              aria-hidden
              fontSize={14}
              minWidth={28}
            >
              {sectionNumber != null
                ? String(sectionNumber).padStart(2, "0")
                : "—"}
            </Text>
            <YStack gap="$1" flexShrink={1} minWidth={0}>
              {/* clamp() lets a single CSS rule scale from 20px on phones up
                  to 32px on desktop — avoids the variant="h3" 32px override
                  and the SSR/hydration flash where useIsMobile starts false.
                  Rendered as <h2> so section titles follow the hero h1. */}
              <h2
                style={{
                  fontFamily: "var(--th-font-body, 'Montserrat', sans-serif)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  fontSize: "clamp(20px, 5vw, 32px)",
                  lineHeight: 1.15,
                  color: "var(--color, #211C16)",
                  display: "block",
                  margin: 0,
                }}
              >
                {String(t("common.browseByCategory"))}
              </h2>
              <Text
                variant="caption"
                tone="muted"
                textTransform="uppercase"
                letterSpacing={1}
              >
                {String(t("common.findEventsMatchInterests"))}
              </Text>
            </YStack>
          </XStack>
          {/* On a phone the title eats the first line and this cluster wraps
              onto its own, left-aligned under the caption (same as the sibling
              HomeEventSection). The header's `$3` gap is a CSS `gap`, so it is
              also the 12px row-gap between the title block and the wrapped
              cluster. `flexShrink: 0` keeps the toggle + link from being
              squeezed; on a phone the cluster is ~200px wide (two 44px toggle
              buttons + the 12px gap + "VIEW ALL →"), so it fits the 288px
              content column at 320px and, as a non-shrinking item in a
              wrapping row, simply takes its own line. */}
          {activeCategory ? (
            <XStack gap="$3" alignItems="center" flexShrink={0}>
              <ViewToggle value={viewMode} onChange={setViewMode} />
              <ViewAllLink
                href={links.path({
                  kind: "category",
                  slugs: categoryLinkSlugs(activeCategory),
                })}
              />
            </XStack>
          ) : null}
        </SectionHeader>

        {/* Wrapping category chips. `tablist`/`tab` semantics are right here
            (unlike the hero's chips, which are links): a chip selects a
            category in place and the grid below is its panel. */}
        <CategoryRow
          role="tablist"
          aria-label={String(t("common.browseByCategory"))}
        >
          {catsLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <Chip
                  key={i}
                  tone="neutral"
                  variant="outline"
                  size="md"
                  interactive={false}
                  borderColor="$colorMuted"
                >
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
                </Chip>
              ))
            : categories.map((cat) => (
                <CategoryChip
                  key={cat.slug}
                  category={cat}
                  selected={cat.slug === activeSlug}
                  onSelect={handleSelect}
                />
              ))}
        </CategoryRow>

        {/* Event grid for the selected category. 24px below the last chip
            row — one step up from the header→chips gap, so the chips read as
            part of the header cluster and the grid (whose first line is its
            own "Showing N events" count) reads as the content below it. */}
        <YStack marginTop="$5">
          <EventGrid
            events={eventsWithSaved}
            loading={eventsLoading}
            variant={viewMode}
            minCardWidth={240}
            testIdBase="category-events"
            onCardPress={handleEventPress}
            onFavoriteToggle={onFavoriteToggle}
          />
        </YStack>
      </div>
    </SectionContainer>
  );
});
