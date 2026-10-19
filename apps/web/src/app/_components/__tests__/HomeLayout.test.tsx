import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
let mockUserCoords: { lat: number; lng: number } | null = null;
let mockCountryCode: string | null = "US";
let mockHeroStyle: "map" | "carousel" | "both" = "carousel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  // The home sections link in the page's language (spanish-seo FR-006).
  usePathname: () => "/",
}));

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const styled = () => passthrough;
  return {
    YStack: passthrough,
    XStack: passthrough,
    styled,
  };
});

vi.mock("@th/ui", () => {
  const Button = ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onPress?.()}>
      {children}
    </button>
  );

  const EventGrid = ({
    loading,
    testIdBase,
    events,
  }: {
    loading?: boolean;
    testIdBase?: string;
    events?: Array<{ title?: string; slug?: string | null }>;
  }) => (
    <div data-testid={testIdBase ?? "event-grid"} data-loading={loading}>
      {events?.map((event) => (
        <div key={event.slug ?? event.title}>{event.title}</div>
      ))}
    </div>
  );

  const Chip = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );

  const ViewToggle = () => <div data-testid="view-toggle" />;

  // ViewAllLink (rendered by HomeLayout when events exist) renders
  // `NextLinkAnchor`; the suite throws on collect without this stub.
  const NextLinkAnchor = ({
    children,
    href,
  }: {
    children?: ReactNode;
    href?: string;
  }) => <a href={href}>{children}</a>;

  return {
    Button,
    Chip,
    EventGrid,
    ViewToggle,
    NextLinkAnchor,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    // Category names are picked by locale (useCategoryBrowse).
    useLocale: () => "en",
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({
      dateTime: (date: Date) => String(date),
    }),
  };
});

vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../home/HomeHero", () => ({
  HomeHero: ({ sectionNumber }: { sectionNumber?: number }) => (
    <div data-testid="home-hero" data-section-number={sectionNumber} />
  ),
}));

vi.mock("../home/FeaturedHeroCarousel", () => ({
  FeaturedHeroCarousel: () => <div data-testid="featured-hero-carousel" />,
}));

// Per-render log of what the S2 band was handed. The FIRST entry is the render
// React hydrates against — the one the country fork used to empty out — and it
// has to be asserted separately from the settled one. Still renders a real
// `<section aria-label>` (and mirrors `minItems = 3`) so the role/name queries
// further down keep testing the same thing they did against the real band.
const mockMarqueeRenders: number[] = [];
vi.mock("../home/MarqueeBand", () => ({
  MarqueeBand: ({
    items,
    sectionAriaLabel,
  }: {
    items: unknown[];
    sectionAriaLabel: string;
  }) => {
    mockMarqueeRenders.push(items.length);
    if (items.length < 3) return null;
    return <section aria-label={sectionAriaLabel} />;
  },
}));

vi.mock("@/lib/location/infer-country", () => ({
  inferCountryCodeFromNavigator: () => mockCountryCode,
}));

vi.mock("@/hooks/user-location/useUserLocation", () => ({
  useUserLocation: () => ({
    coords: mockUserCoords,
    loading: false,
    request: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: null,
      isPending: false,
    }),
  },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({
    showSignInOverlay: vi.fn(),
  }),
}));

// Loose shapes for the query mocks. The defaults below are FACTORIES with an
// explicit return type: inferring it from the default literal would pin every
// per-test override to the default's exact shape (`data: null` and richer
// event/item objects are all legitimate), and `apps/web` typechecks its tests.
type MockEventLike = {
  id: string;
  title: string;
  venue: string;
  date: string;
  priceLabel: string;
  slug: string;
  startsAt?: string;
  media?: { url: string; alt: string };
};

type MockFeaturedItem = {
  id: string;
  itemType?: string;
  itemId?: string;
  title?: string;
  subtitle?: string | null;
  heroImageUrl?: string | null;
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  sortOrder?: number;
};

type MockQueryResult<T> = {
  data: T | null;
  isLoading: boolean;
  isError?: boolean;
  isFetching?: boolean;
  error?: { data?: { code?: string } } | null;
};

// Mock return values for the new search endpoints. Events are EventSummary-
// shaped (venue/date/priceLabel present) — EventMarquee reads venue + date
// off `popular.events`, so a stale doc-shaped mock would crash the render.
//
// Every default is a FACTORY restored in `beforeEach`, and every per-test
// override below is a sticky `mockReturnValue`, never `mockReturnValueOnce`.
// HomeLayout renders at least twice per mount by design — the mount effect
// swaps the SSR country for the navigator-inferred one (see the
// `inferredCountryCode` comment in HomeLayout.tsx) — so a `…Once` value is
// consumed by the FIRST render and the assertion then reads the default off
// the second. That coupled the suite to the render count and hid the change.
const defaultTieredPopularEvents = (): MockQueryResult<{
  events: MockEventLike[];
  tier: string;
  latencyMs: number;
}> => ({
  data: {
    events: [
      {
        id: "evt-1",
        title: "Test Event",
        venue: "Test Venue",
        date: "Sat Oct 5",
        priceLabel: "See details",
        slug: "test-event",
        startsAt: "2024-10-05T18:00:00.000Z",
      },
    ],
    tier: "country",
    latencyMs: 10,
  },
  isLoading: false,
  isError: false,
});
const mockTieredPopularEventsQuery = vi.fn(defaultTieredPopularEvents);

const defaultFeaturedEvents = (): MockQueryResult<{
  events: MockEventLike[];
  latencyMs: number;
}> => ({
  data: {
    events: [],
    latencyMs: 5,
  },
  isLoading: false,
  isError: false,
});
const mockFeaturedEventsQuery = vi.fn(defaultFeaturedEvents);

const defaultDiscoverEventsByCategory = (): MockQueryResult<{
  events: MockEventLike[];
}> => ({
  data: { events: [] },
  isLoading: false,
  isError: false,
  error: null,
});
const mockDiscoverEventsByCategoryQuery = vi.fn(
  defaultDiscoverEventsByCategory,
);

type MockCountryEvent = {
  id: string;
  title: string;
  venue: string;
  date: string;
  priceLabel: string;
  slug: string;
  startsAt: string;
  /** The feature poster requires art — a poster with no image is a caption. */
  media?: { url: string; alt: string };
};

type MockCountryEventsResult = {
  data: {
    events: MockCountryEvent[];
  } | null;
  isLoading: boolean;
  isFetching: boolean;
};

const makeCountryEvent = (
  over: Partial<MockCountryEvent> = {},
): MockCountryEvent => ({
  id: "evt-1",
  title: "Test Event",
  venue: "Test Venue",
  date: "Sat Oct 5",
  priceLabel: "See details",
  slug: "test-event",
  startsAt: "2024-10-05T18:00:00.000Z",
  ...over,
});

const defaultCountryEvents = (): MockCountryEventsResult => ({
  data: {
    events: [makeCountryEvent()],
  },
  isLoading: false,
  isFetching: false,
});
/**
 * Takes the hook's INPUT so tests can assert the react-query key the client
 * queries with. `countryCode` on the first call is the SSR/hydration contract:
 * it has to equal what `prefetchHomeDiscovery` seeded, or the first client
 * render misses the cache.
 */
const mockCountryEventsQuery = vi.fn(
  (_input?: { countryCode?: string; limit?: number }): MockCountryEventsResult =>
    defaultCountryEvents(),
);

const defaultFeaturedItemsList = (): MockQueryResult<{
  items: MockFeaturedItem[];
}> => ({
  data: { items: [] },
  isLoading: false,
  isError: false,
});
const mockFeaturedItemsListQuery = vi.fn(defaultFeaturedItemsList);

const defaultCategoryList = (): MockQueryResult<{
  categories: Array<{ id: string; slug: string; name: string }>;
}> => ({
  data: { categories: [] },
  isLoading: false,
  isError: false,
});
// `categories.listBrowsable`: what the home page's browse section and its
// ordinal gate read (categories whose page lists something).
const mockCategoryListQuery = vi.fn(defaultCategoryList);
// `categories.list`: every active category, empty ones included. Non-empty by
// default, so a gate or section that read it instead of the browse list would
// render a category section the browse list says has nothing (owner ruling
// 2026-10-14) and fail the ordinal tests below.
const mockAllCategoriesQuery = vi.fn(() => ({
  data: {
    categories: [{ id: "cat-empty", slug: "empty", name: "Empty" }],
  },
  isLoading: false,
  isError: false,
}));

const defaultEventsByCategory = (): MockQueryResult<{
  events: MockEventLike[];
  total: number;
}> => ({
  data: { events: [], total: 0 },
  isLoading: false,
  isError: false,
});
const mockEventsByCategoryQuery = vi.fn(defaultEventsByCategory);

vi.mock("@/trpc", () => ({
  trpc: {
    // Saved-events surface (useEventSaves / SavedStrip). The suite renders
    // signed-out, so these all sit idle.
    useQueries: () => [],
    useUtils: () => ({
      eventSaves: {
        savedState: { invalidate: vi.fn() },
        listMine: { invalidate: vi.fn() },
      },
    }),
    eventSaves: {
      listMine: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          isError: false,
        }),
      },
      save: { useMutation: () => ({ mutate: vi.fn() }) },
      unsave: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    events: {
      // EventMarquee (S2 Signal) is rendered unconditionally by HomeLayout and
      // feeds off `popular.events` (this query in the default no-coords path).
      // The single-event default keeps the marquee self-hidden (it needs 3+
      // items), so it stays out of the way of the assertions below.
      countryEvents: {
        useQuery: (input: { countryCode?: string; limit?: number }) =>
          mockCountryEventsQuery(input),
      },
    },
    search: {
      tieredPopularEvents: {
        useQuery: () => mockTieredPopularEventsQuery(),
      },
      discoverEventsByCategory: {
        useQuery: () => mockDiscoverEventsByCategoryQuery(),
      },
      featuredEvents: {
        useQuery: () => mockFeaturedEventsQuery(),
      },
    },
    featuredItems: {
      list: {
        useQuery: () => mockFeaturedItemsListQuery(),
      },
    },
    platform: {
      getPublicSettings: {
        useQuery: () => ({
          data: {
            settings: [{ key: "homepage:heroStyle", value: mockHeroStyle }],
          },
          isLoading: false,
          isError: false,
        }),
      },
    },
    categories: {
      list: {
        useQuery: () => mockAllCategoriesQuery(),
      },
      listBrowsable: {
        useQuery: () => mockCategoryListQuery(),
      },
      eventsByCategory: {
        useQuery: () => mockEventsByCategoryQuery(),
      },
    },
  },
}));

import { HomeLayout } from "../HomeLayout";
// The real constant, not a copy: it IS the SSR/hydration contract, and a
// literal here would keep passing the day the server's seed country changes.
import { HOME_SSR_COUNTRY } from "@/lib/location/home-ssr-country";

describe("HomeLayout", () => {
  beforeEach(() => {
    pushMock.mockClear();
    mockMarqueeRenders.length = 0;
    mockUserCoords = null;
    mockCountryCode = "US";
    mockHeroStyle = "carousel";
    // Full reset (calls AND any sticky return value a test installed), then
    // reinstate the default. `mockClear` alone would leak a previous test's
    // `mockReturnValue` into every test after it.
    mockTieredPopularEventsQuery.mockReset();
    mockTieredPopularEventsQuery.mockImplementation(defaultTieredPopularEvents);
    mockFeaturedEventsQuery.mockReset();
    mockFeaturedEventsQuery.mockImplementation(defaultFeaturedEvents);
    mockFeaturedItemsListQuery.mockReset();
    mockFeaturedItemsListQuery.mockImplementation(defaultFeaturedItemsList);
    mockDiscoverEventsByCategoryQuery.mockReset();
    mockDiscoverEventsByCategoryQuery.mockImplementation(
      defaultDiscoverEventsByCategory,
    );
    mockCountryEventsQuery.mockReset();
    mockCountryEventsQuery.mockImplementation(() => defaultCountryEvents());
    // useBrowseCategoryList is called TWICE per render (HomeLayout's ordinal gate +
    // CategoryBrowseSection itself), so per-test overrides must be sticky.
    mockCategoryListQuery.mockReset();
    mockCategoryListQuery.mockImplementation(defaultCategoryList);
    mockEventsByCategoryQuery.mockReset();
    mockEventsByCategoryQuery.mockImplementation(defaultEventsByCategory);
  });

  it("renders the popular events section with title based on tier", () => {
    render(<HomeLayout />);
    // With no coords the title is the honest, date-accurate "Upcoming events"
    // (popularityScore is data-starved at launch, so we don't claim "Popular").
    expect(screen.getByText("home.upcomingEvents")).toBeInTheDocument();
  });

  it("renders EventGrid with loading state when data is loading", () => {
    mockTieredPopularEventsQuery.mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
    });

    mockCountryEventsQuery.mockReturnValue({
      data: null,
      isLoading: true,
      isFetching: true,
    });

    render(<HomeLayout />);
    const grid = screen.getByTestId("home-events");
    expect(grid).toHaveAttribute("data-loading", "true");
  });

  it("renders EventGrid with events when data is loaded", () => {
    render(<HomeLayout />);
    const grid = screen.getByTestId("home-events");
    expect(grid).toHaveAttribute("data-loading", "false");
  });

  it("renders children when provided", () => {
    render(
      <HomeLayout>
        <div data-testid="child-content">Child Content</div>
      </HomeLayout>,
    );
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  // The old "featured events" HomeEventSection was replaced by the
  // FeaturedHeroCarousel in the v2 rollout — assert the carousel instead.
  it("renders the featured hero carousel when featured items exist", () => {
    mockFeaturedItemsListQuery.mockReturnValue({
      data: { items: [{ id: "fi-1" }] },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);
    expect(screen.getByTestId("featured-hero-carousel")).toBeInTheDocument();
  });

  /**
   * The grid poster is gone, so nothing suppresses the carousel any more.
   *
   * The poster spanned two grid rows, which stretched the cards beside it to
   * half its height and left them with a band of dead space; every card is one
   * size now. The carousel is the page's feature slot again — and the only one
   * that can promote humans, organizations and places rather than just events.
   */
  it("keeps the carousel even when a curated event with art is in the grid", () => {
    mockCountryEventsQuery.mockReturnValue({
      data: {
        events: [
          makeCountryEvent({
            id: "evt-curated",
            media: { url: "https://img.test/hero.jpg", alt: "Hero" },
          }),
        ],
      },
      isLoading: false,
      isFetching: false,
    });
    mockFeaturedItemsListQuery.mockReturnValue({
      data: {
        items: [{ id: "fi-1", itemType: "EVENT", itemId: "evt-curated" }],
      },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);

    expect(screen.getByTestId("featured-hero-carousel")).toBeInTheDocument();
  });

  it("keeps the carousel when the curated item is not an event in this grid", () => {
    // A curated VENUE has no card to become a poster, and the carousel is the
    // only way to feature it — removing it outright would silently drop
    // promotion for humans, organizations and places.
    mockFeaturedItemsListQuery.mockReturnValue({
      data: {
        items: [{ id: "fi-1", itemType: "PLACE", itemId: "place-1" }],
      },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);

    expect(screen.getByTestId("featured-hero-carousel")).toBeInTheDocument();
  });

  it("keeps the carousel when the curated event has no art", () => {
    mockFeaturedItemsListQuery.mockReturnValue({
      data: {
        items: [{ id: "fi-1", itemType: "EVENT", itemId: "evt-1" }],
      },
      isLoading: false,
      isError: false,
    });

    // `makeCountryEvent()` has no media, so "evt-1" cannot carry a poster.
    render(<HomeLayout />);

    expect(screen.getByTestId("featured-hero-carousel")).toBeInTheDocument();
  });

  it("falls back to country events when geo popular search is unavailable", () => {
    mockUserCoords = { lat: 40.7, lng: -74 };
    mockTieredPopularEventsQuery.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      error: { data: { code: "PRECONDITION_FAILED" } },
    });

    render(<HomeLayout />);

    // country tier now renders the honest "Upcoming events" label (not "Popular").
    expect(screen.getByText("home.upcomingEvents")).toBeInTheDocument();
    expect(screen.getByTestId("home-events")).toHaveAttribute(
      "data-loading",
      "false",
    );
    expect(screen.queryByText("home.emptyStateCta")).not.toBeInTheDocument();
  });

  it("hides the popular section when geo search is unavailable and no DB fallback events exist", () => {
    mockUserCoords = { lat: 40.7, lng: -74 };
    mockTieredPopularEventsQuery.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      error: { data: { code: "PRECONDITION_FAILED" } },
    });
    mockCountryEventsQuery.mockReturnValue({
      data: { events: [] },
      isLoading: false,
      isFetching: false,
    });

    render(<HomeLayout />);

    expect(screen.queryByTestId("home-events")).not.toBeInTheDocument();
    expect(screen.queryByText("home.emptyStateCta")).not.toBeInTheDocument();
  });

  it("falls back to DB country events even when navigator country inference is missing", () => {
    mockUserCoords = { lat: 40.7, lng: -74 };
    mockCountryCode = null;
    mockTieredPopularEventsQuery.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      error: { data: { code: "PRECONDITION_FAILED" } },
    });

    render(<HomeLayout />);

    expect(screen.getByTestId("home-events")).toBeInTheDocument();
    expect(screen.getByText("Test Event")).toBeInTheDocument();
  });

  it("renders category browse events from the DB fallback when category search is empty", () => {
    // Not Once: the hook is consumed by both HomeLayout and the section.
    mockCategoryListQuery.mockReturnValue({
      data: {
        categories: [{ id: "cat-1", slug: "rock", name: "Rock" }],
      },
      isLoading: false,
      isError: false,
    });
    mockDiscoverEventsByCategoryQuery.mockReturnValue({
      data: { events: [] },
      isLoading: false,
      isError: false,
      error: null,
    });
    mockEventsByCategoryQuery.mockReturnValue({
      data: {
        events: [
          {
            id: "evt-9",
            title: "Seeded Rock Show",
            venue: "Test Venue",
            date: "Sat, Oct 5",
            priceLabel: "See details",
            slug: "seeded-rock-show",
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);

    expect(screen.getByText("common.browseByCategory")).toBeInTheDocument();
    expect(screen.getByTestId("category-events")).toHaveAttribute(
      "data-loading",
      "false",
    );
    expect(screen.getByText("Seeded Rock Show")).toBeInTheDocument();
  });

  it("renders View All link in popular section when events exist", () => {
    render(<HomeLayout />);
    // Popular section has events from the default mock → View All should appear
    const viewAllLinks = screen.getAllByText(/common\.viewAll/);
    expect(viewAllLinks.length).toBeGreaterThanOrEqual(1);
  });

  // ── SSR country / hydration contract ─────────────────────────────────────

  /**
   * The bug this pins: `HomeLayout` used to read `navigator.language` DURING
   * the first client render, so a Spanish browser queried `countryCode: "ES"`
   * while `page.tsx` had server-rendered and prefetched `HOME_SSR_COUNTRY`.
   * The first client render therefore missed the hydrated cache, `popular`
   * came back empty, `EventMarquee` self-hid (it needs 3+ events), the
   * container emitted one FEWER child than the server, and React failed
   * hydration and regenerated the subtree — on every non-US locale.
   */
  it("always queries the SSR country, and never the navigator's", () => {
    // The browser's country is not a location signal and is no longer read.
    // Every render must use the key `page.tsx` prefetched, so the first client
    // render is a cache hit and there is no second request to a country with
    // no inventory.
    mockCountryCode = "ES";

    render(<HomeLayout />);

    const countries = mockCountryEventsQuery.mock.calls.map(
      ([input]) => input?.countryCode,
    );
    expect(countries.length).toBeGreaterThan(0);
    expect(countries.every((c) => c === HOME_SSR_COUNTRY)).toBe(true);
    expect(countries).not.toContain("ES");
  });

  it("never queries with an undefined country", () => {
    // The trap: `usePopularEvents` sends `regionCode ?? undefined`, and
    // `countryCode: undefined` is a DIFFERENT react-query key from "US", so a
    // null reaching the hook would miss the hydrated cache just as badly as
    // "ES" did.
    mockCountryCode = null;

    render(<HomeLayout />);

    const countries = mockCountryEventsQuery.mock.calls.map(
      ([input]) => input?.countryCode,
    );
    expect(countries.length).toBeGreaterThan(0);
    expect(countries.every((c) => c === HOME_SSR_COUNTRY)).toBe(true);
  });

  it("keeps the marquee on the first render for a non-US locale", () => {
    // Mirrors the real cache: only the SSR country has data on the first
    // render, because that is the key `page.tsx` hydrated. Under the old code
    // an ES browser queried "ES" immediately, got nothing, and the band
    // vanished from the first render — one child fewer than the server sent,
    // which is exactly the mismatch React reported.
    mockCountryCode = "ES";
    mockCountryEventsQuery.mockImplementation((input) =>
      input?.countryCode === HOME_SSR_COUNTRY
        ? {
            data: {
              events: [
                makeCountryEvent({
                  id: "evt-a",
                  slug: "show-a",
                  title: "Show A",
                }),
                makeCountryEvent({
                  id: "evt-b",
                  slug: "show-b",
                  title: "Show B",
                }),
                makeCountryEvent({
                  id: "evt-c",
                  slug: "show-c",
                  title: "Show C",
                }),
              ],
            },
            isLoading: false,
            isFetching: false,
          }
        : { data: { events: [] }, isLoading: false, isFetching: false },
    );

    render(<HomeLayout />);

    // The band is populated on the render hydration compares against.
    expect(mockMarqueeRenders[0]).toBe(3);
  });

  // ── S2 Signal event marquee ───────────────────────────────────────────────

  it("renders the event marquee when 3+ popular events exist", () => {
    mockCountryEventsQuery.mockReturnValue({
      data: {
        events: [
          makeCountryEvent({ id: "evt-a", slug: "show-a", title: "Show A" }),
          makeCountryEvent({ id: "evt-b", slug: "show-b", title: "Show B" }),
          makeCountryEvent({ id: "evt-c", slug: "show-c", title: "Show C" }),
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<HomeLayout />);

    expect(
      screen.getByRole("region", { name: "home.upcomingEvents" }),
    ).toBeInTheDocument();
  });

  it("self-hides the event marquee below 3 events", () => {
    // Default mock: a single popular event → the S2 strip renders null.
    render(<HomeLayout />);

    expect(
      screen.queryByRole("region", { name: "home.upcomingEvents" }),
    ).not.toBeInTheDocument();
  });

  // ── S6 Convert band + page-global section numbering ──────────────────────

  it("always renders the host convert band with its CTA", () => {
    render(<HomeLayout />);
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /honesty and transparency is the floor/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("home.createAnEvent")).toBeInTheDocument();
  });

  it("numbers sections top-to-bottom without the map hero (carousel mode)", () => {
    mockCategoryListQuery.mockReturnValue({
      data: { categories: [{ id: "cat-1", slug: "rock", name: "Rock" }] },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);

    // No map hero in carousel mode → popular starts at 01.
    expect(screen.queryByTestId("home-hero")).not.toBeInTheDocument();

    // Scope kicker assertions to outside the convert band. Its audience list
    // carries no numerals any more (it used to render bare "01"/"02"/"03"
    // step numbers), so the filter is belt-and-braces against that coming
    // back — the assertions' behaviour is unchanged either way.
    const convertRegion = screen.getByRole("region", {
      name: /honesty and transparency is the floor/i,
    });
    const popularKickers = screen
      .getAllByText("01")
      .filter((el) => !convertRegion.contains(el));
    expect(popularKickers).toHaveLength(1);
    const categoryKickers = screen
      .getAllByText("02")
      .filter((el) => !convertRegion.contains(el));
    expect(categoryKickers).toHaveLength(1);
    // Convert band kicker uses the "NN." format (unique — nothing else in the
    // band renders a dotted numeral).
    expect(screen.getByText("03.")).toBeInTheDocument();
  });

  it("numbers sections top-to-bottom with the map hero first", () => {
    mockHeroStyle = "map";
    mockCategoryListQuery.mockReturnValue({
      data: { categories: [{ id: "cat-1", slug: "rock", name: "Rock" }] },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);

    expect(screen.getByTestId("home-hero")).toHaveAttribute(
      "data-section-number",
      "1",
    );

    const convertRegion = screen.getByRole("region", {
      name: /honesty and transparency is the floor/i,
    });
    const popularKickers = screen
      .getAllByText("02")
      .filter((el) => !convertRegion.contains(el));
    expect(popularKickers).toHaveLength(1);
    const categoryKickers = screen
      .getAllByText("03")
      .filter((el) => !convertRegion.contains(el));
    expect(categoryKickers).toHaveLength(1);
    expect(screen.getByText("04.")).toBeInTheDocument();
  });

  it("does not consume an ordinal for a category section that never renders", () => {
    // Default mock: browsable categories loaded empty (while the full active
    // list is NOT empty) → CategoryBrowseSection is gated out, so in carousel
    // mode numbering must run popular 01 → convert 02.
    render(<HomeLayout />);

    expect(
      screen.queryByText("common.browseByCategory"),
    ).not.toBeInTheDocument();

    const convertRegion = screen.getByRole("region", {
      name: /honesty and transparency is the floor/i,
    });
    const popularKickers = screen
      .getAllByText("01")
      .filter((el) => !convertRegion.contains(el));
    expect(popularKickers).toHaveLength(1);
    expect(screen.getByText("02.")).toBeInTheDocument();
    // No skipped ordinal left behind outside the convert band's audience list.
    const straggler = screen
      .queryAllByText("03")
      .filter((el) => !convertRegion.contains(el));
    expect(straggler).toHaveLength(0);
  });

  it("renders hero and carousel together in 'both' mode without the hidden h1", () => {
    mockHeroStyle = "both";
    mockFeaturedItemsListQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "feat-1",
            itemType: "EVENT",
            title: "Featured Show",
            subtitle: null,
            heroImageUrl: null,
            ctaUrl: null,
            ctaLabel: null,
            sortOrder: 0,
          },
        ],
      },
      isLoading: false,
      isError: false,
    });

    render(<HomeLayout />);

    // Map hero (mocked, owns the real h1 in production) + carousel coexist;
    // the sr-only fallback h1 must NOT render (strict carousel-only check).
    expect(screen.getByTestId("home-hero")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 1 }),
    ).not.toBeInTheDocument();
  });

  // ── Carousel-only h1 ──────────────────────────────────────────────────────

  it("renders a visually-hidden h1 in carousel-only mode", () => {
    render(<HomeLayout />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("home.heroTitle home.heroTitleAccent");
  });

  it("does not render the hidden h1 when the map hero is present", () => {
    mockHeroStyle = "map";
    render(<HomeLayout />);
    // The (mocked) map hero owns the page h1 in map mode — HomeLayout must
    // not add a second one.
    expect(
      screen.queryByRole("heading", { level: 1 }),
    ).not.toBeInTheDocument();
  });
});
