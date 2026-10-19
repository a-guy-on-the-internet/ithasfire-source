"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, styled } from "tamagui";

import { Button, Text, useTranslations } from "@th/ui";

import { HOME_SSR_COUNTRY } from "@/lib/location/home-ssr-country";
import { useUserLocation } from "@/hooks/user-location/useUserLocation";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { authClient } from "@/lib/auth/auth-client";
import {
  HomeEventSection,
  HomeHero,
  usePopularEvents,
  useBrowseCategoryList,
  CategoryBrowseSection,
  FeaturedHeroCarousel,
  HostConvertBand,
  EventMarquee,
  SavedStrip,
} from "./home";
import { useSavedEventSummaries } from "@/components/saves/useEventSaves";
import { trpc } from "@/trpc";
import { ViewAllLink } from "./home/ViewAllLink";

const HomeLayoutContainer = styled(YStack, {
  name: "HomeLayoutContainer",
  gap: "$6",
  width: "100%",
  // Vertical padding is handled by AppShell's MainContent — don't stack.
});

type HomeLayoutProps = {
  children?: ReactNode;
};

/**
 * Maps geo tier from tieredPopularEvents to a translation key.
 *
 * We deliberately never claim "Popular" here: popularityScore is data-starved
 * at launch volume (≈0 for every event), so the underlying rows are ordered by
 * distance (with coords) or start date (no coords / country query), not by any
 * real popularity signal. The "Near You" / "In Your Region" labels are honest
 * (distance-sorted); every other case falls back to the honest, date-accurate
 * "Upcoming events" rather than a false "Popular" label.
 */
const getTierTitleKey = (
  tier: "local" | "regional" | "country" | "global" | null,
  hasCoords: boolean,
): string => {
  if (!hasCoords) return "home.upcomingEvents";
  switch (tier) {
    case "local":
      return "home.eventsNearYou";
    case "regional":
      return "home.eventsInYourRegion";
    case "country":
      return "home.upcomingEvents";
    case "global":
      return "home.upcomingEvents";
    default:
      return "home.upcomingEvents";
  }
};

export const HomeLayout = ({ children }: HomeLayoutProps) => {
  const router = useRouter();
  const t = useTranslations();
  const prefetchedEventSlugsRef = useRef<Set<string>>(new Set());
  const { showSignInOverlay } = useAppOverlay();

  const sessionQuery = authClient.useSession();
  const isSignedIn = Boolean(sessionQuery.data?.user);

  // Location is available if user previously granted permission (no auto-prompt)
  const { coords: userCoords } = useUserLocation({ requestOnMount: false });
  // The country is NOT derived from the browser. `page.tsx` renders and
  // prefetches these sections for ONE fixed country (`HOME_SSR_COUNTRY`)
  // because the HTML is edge-cached and the cache key carries no country, so
  // querying that same country here makes the first client render a cache HIT.
  //
  // We used to infer it from `navigator.language`, and it cost more than it
  // bought. That is a language preference, not a location — an American whose
  // OS is in French reports `fr-FR` — and it broke three ways at once:
  //
  //   - it forked the react-query key away from the prefetched one on the
  //     FIRST client render, so that render saw zero events, `EventMarquee`
  //     self-hid (it needs 3+), the container emitted one FEWER child than the
  //     server had, and React failed hydration and regenerated the subtree.
  //     Reproduced on every non-US locale — en-GB, es-ES, fr-FR, pt-BR — and
  //     never on en-US, which is why it read as a Spanish bug and is not one;
  //   - it then settled on a country with no inventory, so a non-US viewer's
  //     home page emptied out a second after it finished loading;
  //   - it spent a round trip to get there.
  //
  // Real location is still honoured, from a real signal: `userCoords` is
  // granted geolocation, and it drives the tiered "near you" query that sits
  // ABOVE this country fallback inside `usePopularEvents`.

  // ── Event section hooks ────────────────────────────────────────────────────

  const popular = usePopularEvents(userCoords, HOME_SSR_COUNTRY);
  // Shared with CategoryBrowseSection (react-query dedupes) — used only to
  // know whether that section will render, for the ordinal counter below.
  // Same browse list the section renders, so the gate and the section agree.
  const { categories, isLoading: categoriesLoading } = useBrowseCategoryList();
  // Merge the viewer's saved flags into the popular cards (heart toggle).
  const popularSaved = useSavedEventSummaries(popular.events);
  const popularSectionTitle = String(
    t(getTierTitleKey(popular.tier, !!userCoords)),
  );
  const shouldRenderPopularSection =
    popular.isLoading || popular.events.length > 0 || !popular.isUnavailable;

  const featuredItemsQuery = trpc.featuredItems.list.useQuery(
    { limit: 8 },
    { staleTime: 120_000, retry: false, refetchOnWindowFocus: false },
  );
  const featuredItems = featuredItemsQuery.data?.items ?? [];

  /**
   * The grid no longer nominates a poster.
   *
   * The poster spanned two columns AND two rows, which made the two cards
   * beside it stretch to half the poster's height — 507px of card around 390px
   * of content, so both carried a band of dead space between their meta and
   * their foot. It also drove the rows it spanned, so card heights changed down
   * the page. Every card is now the same size (see `gridAutoRows` in
   * `EventGrid`).
   *
   * `FeaturedHeroCarousel` below is therefore no longer suppressed — it is the
   * page's feature slot again, and it is the only one that can promote humans,
   * organizations and places rather than just events. It renders only when
   * `homepage:heroStyle` is `carousel` or `both`; the default is `map`, so
   * today this changes nothing above the grid.
   */

  const heroStyleQuery = trpc.platform.getPublicSettings.useQuery(
    { keys: ["homepage:heroStyle"] },
    { staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const rawHeroStyle = heroStyleQuery.data?.settings?.find(
    (s: { key: string }) => s.key === "homepage:heroStyle",
  )?.value;
  const heroStyle: "map" | "carousel" | "both" =
    rawHeroStyle === "carousel" || rawHeroStyle === "both"
      ? rawHeroStyle
      : "map";

  // ── Route prefetching ─────────────────────────────────────────────────────

  const prefetchEventSlug = useCallback(
    (slug: string | undefined | null) => {
      if (!slug || prefetchedEventSlugsRef.current.has(slug)) return;
      prefetchedEventSlugsRef.current.add(slug);
      try {
        router.prefetch(`/events/${slug}`);
      } catch {
        prefetchedEventSlugsRef.current.delete(slug);
      }
    },
    [router],
  );

  const allEventSlugs = useMemo(() => {
    const slugs: (string | null | undefined)[] = [];
    popular.events.forEach((e) => slugs.push(e.slug));
    return slugs;
  }, [popular.events]);

  useEffect(() => {
    allEventSlugs.forEach((slug) => prefetchEventSlug(slug));
  }, [allEventSlugs, prefetchEventSlug]);

  // ── Empty state ───────────────────────────────────────────────────────────

  const goToEventCreation = useCallback(() => {
    if (isSignedIn) {
      router.push("/admin?intent=create-event");
    } else {
      showSignInOverlay({ redirect: "/admin?intent=create-event" });
    }
  }, [router, isSignedIn, showSignInOverlay]);

  const renderEmptyState = useCallback(
    () => (
      <YStack gap="$3" alignItems="center" paddingVertical="$4">
        <Text variant="body" weight="bold" textAlign="center">
          {String(t("home.emptyStateCta"))}
        </Text>
        <Button size="$3" onPress={goToEventCreation}>
          {String(t("home.createAnEvent"))}
        </Button>
      </YStack>
    ),
    [goToEventCreation],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  // Page-global section ordinals, counted top-to-bottom over the bands that
  // actually render a numbered kicker: map hero → popular events → category
  // browse → host convert. Fixes the old bug where the hero hardcoded "01."
  // and the popular section also rendered "01". `showCategorySection` mirrors
  // CategoryBrowseSection's own self-null condition (it returns null when
  // categories finished loading empty) so the ordinal isn't consumed by a
  // section that never renders — react-query dedupes the shared hook call.
  const showMapHero = heroStyle === "map" || heroStyle === "both";
  const showCategorySection = categoriesLoading || categories.length > 0;
  let sectionOrdinal = 1;
  const heroSectionNumber = showMapHero ? sectionOrdinal++ : undefined;
  const popularSectionNumber = shouldRenderPopularSection
    ? sectionOrdinal++
    : undefined;
  const categorySectionNumber = showCategorySection
    ? sectionOrdinal++
    : undefined;
  const convertSectionNumber = sectionOrdinal++;

  return (
    <HomeLayoutContainer>
      {children}

      {showMapHero && (
        <HomeHero coords={userCoords} sectionNumber={heroSectionNumber} />
      )}

      {/* Carousel-only mode has no visible headline — keep a document h1 for
          the accessibility/heading tree. Visually hidden via the standard
          clip pattern (same as the global .sr-only utility). In map/"both"
          modes the map hero's h1 remains the page's single h1. */}
      {heroStyle === "carousel" && (
        <h1
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clipPath: "inset(50%)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {`${String(t("home.heroTitle"))} ${String(t("home.heroTitleAccent"))}`}
        </h1>
      )}

      {/* The carousel is the page's feature slot again — the grid's poster,
          which used to suppress it, is gone. */}
      {(heroStyle === "carousel" || heroStyle === "both") &&
        featuredItems.length > 0 && <FeaturedHeroCarousel items={featuredItems} />}

      {/* v2 "S2 Signal" — upcoming-events ticker (single-region launch: the
          city list is too thin; CityMarquee is retained for future
          multi-region). Visual chrome, not a numbered section: it does NOT
          consume `sectionOrdinal`, and self-hides on thin (<3 events) /
          loading / error data. */}
      <EventMarquee events={popular.events} />

      {/* Signed-in watchlist shortcut — hidden when empty or signed out. */}
      <SavedStrip />

      {/* All-events list — the geocoded `usePopularEvents` already returns
          the right tiered set (local → regional → country → global) when
          the user's location is known. No real "popularity" ranking yet,
          so this is effectively "events you can actually go to." */}
      {shouldRenderPopularSection ? (
        <HomeEventSection
          title={popularSectionTitle}
          events={popularSaved.events}
          loading={popular.isLoading}
          variant="grid"
          showViewToggle
          testIdBase="home-events"
          sectionNumber={popularSectionNumber}
          onFavoriteToggle={popularSaved.onFavoriteToggle}
          renderEmptyState={
            popular.isUnavailable ? undefined : renderEmptyState
          }
          headerAction={
            popular.events.length > 0 ? (
              <ViewAllLink href="/search?near=1" />
            ) : undefined
          }
        />
      ) : null}

      {/* Gated on the same signal the section itself self-nulls on, so a
          skipped section never eats an ordinal. */}
      {showCategorySection ? (
        <CategoryBrowseSection
          coords={userCoords}
          sectionNumber={categorySectionNumber}
        />
      ) : null}

      {/* v2 "S6 Convert" — the page's one accent-filled band. Marketing
          chrome: always rendered, signed-in or out. */}
      <HostConvertBand
        sectionNumber={convertSectionNumber}
        onCreateEvent={goToEventCreation}
      />
    </HomeLayoutContainer>
  );
};

HomeLayout.displayName = "HomeLayout";
