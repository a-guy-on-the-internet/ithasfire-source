import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";
import type { UseCategoryListResult } from "../useCategoryBrowse";
import type { UseDirectoryPlaceCountResult } from "../useDirectoryPlaceCount";
import type { UseHeroEventsResult } from "../useHeroEvents";

const openSpotlightMock = vi.fn();
let mockConsumerQuery = "";
let mockHeroEvents: UseHeroEventsResult;
let mockPlaceCount: UseDirectoryPlaceCountResult;
let mockCategories: UseCategoryListResult;

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    "aria-hidden": ariaHidden,
  }: {
    children?: ReactNode;
    "aria-hidden"?: boolean;
  }) => <span aria-hidden={ariaHidden}>{children}</span>,
  NextLinkAnchor: ({
    children,
    href,
    className,
  }: {
    children?: ReactNode;
    href?: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  // Keys render as themselves; ICU values are appended so a test can see
  // WHICH count reached the plural message. The real plural forms are
  // asserted separately against the live catalogs below.
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(",")})`
        : key,
}));

vi.mock("@/components/search/spotlight-store", () => ({
  openSpotlight: () => openSpotlightMock(),
  useContextQuery: () => mockConsumerQuery,
}));

// The page's URL decides the chips' language (spanish-seo FR-006).
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

vi.mock("../useHeroEvents", () => ({
  useHeroEvents: () => mockHeroEvents,
}));

vi.mock("../useDirectoryPlaceCount", () => ({
  useDirectoryPlaceCount: () => mockPlaceCount,
}));

// The full active list, empty categories included. The hero must NOT read
// it: browse entry points read only `useBrowseCategoryList` (owner ruling
// 2026-10-14), so a test that wires the two differently catches a regression.
let mockAllCategories: UseCategoryListResult;

vi.mock("../useCategoryBrowse", () => ({
  useCategoryList: () => mockAllCategories,
  useBrowseCategoryList: () => mockCategories,
}));

import { HomeHero } from "../HomeHero";

const loaded = (count: number, hasCoords = false): UseHeroEventsResult => ({
  count,
  isCapped: count >= 50,
  isLoading: false,
  hasCoords,
});

const venues = (count: number): UseDirectoryPlaceCountResult => ({
  count,
  isLoading: false,
});

/**
 * Text of the kicker row's leaves in DOM order (separators included). A count
 * segment wraps its separator + label in `.hh-kicker-seg`; this looks THROUGH
 * that wrapper so the assertion reads like the visible row.
 */
const kickerSegments = () =>
  Array.from(
    document.querySelectorAll(
      ".hh-kicker-row > :not(.hh-kicker-seg), .hh-kicker-row > .hh-kicker-seg > *",
    ),
  ).map((el) => (el.textContent ?? "").trim());

const category = (i: number) => ({
  id: `cat-${i}`,
  slug: `slug-${i}`,
  name: `Category ${i}`,
});

const categoriesLoaded = (n: number): UseCategoryListResult => ({
  categories: Array.from({ length: n }, (_, i) => category(i + 1)),
  isLoading: false,
  isError: false,
});

const trigger = () => screen.getByTestId("home-search-trigger");
const chipGroup = () => screen.getByRole("group", { name: "home.heroBrowseLabel" });
const chipGroupQuery = () =>
  screen.queryByRole("group", { name: "home.heroBrowseLabel" });

describe("HomeHero", () => {
  beforeEach(() => {
    openSpotlightMock.mockClear();
    mockConsumerQuery = "";
    mockHeroEvents = loaded(1);
    // Venues absent by default so the pre-existing single-segment assertions
    // (one "·", one count) keep meaning what they meant.
    mockPlaceCount = venues(0);
    mockCategories = categoriesLoaded(8);
    mockAllCategories = categoriesLoaded(12);
    mockPathname = "/";
  });

  // ── Statement ────────────────────────────────────────────────────────────

  it("renders exactly one h1, with the accent line as its second line", () => {
    render(<HomeHero />);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("home.heroTitle home.heroTitleAccent");
    expect(headings[0]?.querySelector(".hh-line-2")).toHaveTextContent(
      "home.heroTitleAccent",
    );
  });

  it("names the hero region by its own localized headline", () => {
    render(<HomeHero />);

    const region = screen.getByRole("region", {
      name: "home.heroTitle home.heroTitleAccent",
    });
    expect(region).toHaveAttribute("aria-labelledby", "home-hero-heading");
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute(
      "id",
      "home-hero-heading",
    );
  });

  it("renders the zero-padded section ordinal (aria-hidden) beside the location hint", () => {
    render(<HomeHero sectionNumber={3} />);

    expect(screen.getByText("03.")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("home.heroLocationEverywhere")).toBeInTheDocument();
    expect(screen.queryByText("home.heroLocationNearYou")).not.toBeInTheDocument();
  });

  it("switches the location hint when coords are known", () => {
    mockHeroEvents = loaded(1, true);
    render(<HomeHero coords={{ lat: 36.16, lng: -86.78 }} />);

    expect(screen.getByText("home.heroLocationNearYou")).toBeInTheDocument();
    expect(screen.queryByText("home.heroLocationEverywhere")).not.toBeInTheDocument();
  });

  it("renders the lede from the catalog", () => {
    render(<HomeHero />);

    expect(document.querySelector(".hh-lede")).toHaveTextContent("home.heroSubtitle");
  });

  // ── Kicker count: "no number, no band" ───────────────────────────────────

  it("renders the count in the kicker when it is real and > 0", () => {
    mockHeroEvents = loaded(3);
    render(<HomeHero />);

    expect(screen.getByText("home.heroKickerCount(count=3)")).toBeInTheDocument();
    expect(screen.getByText("·")).toHaveAttribute("aria-hidden", "true");
  });

  it("passes a count of 1 through to the plural message", () => {
    mockHeroEvents = loaded(1);
    render(<HomeHero />);

    expect(screen.getByText("home.heroKickerCount(count=1)")).toBeInTheDocument();
  });

  it("renders the capped string at the query ceiling, never a flat count", () => {
    mockHeroEvents = loaded(50);
    render(<HomeHero />);

    expect(
      screen.getByText("home.heroKickerCountCapped(count=50)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/home\.heroKickerCount\(/)).not.toBeInTheDocument();
  });

  it("renders the plural string one below the ceiling", () => {
    mockHeroEvents = loaded(49);
    render(<HomeHero />);

    expect(screen.getByText("home.heroKickerCount(count=49)")).toBeInTheDocument();
    expect(
      screen.queryByText(/home\.heroKickerCountCapped/),
    ).not.toBeInTheDocument();
  });

  it("omits the count and its separator when there are zero events", () => {
    mockHeroEvents = loaded(0);
    render(<HomeHero />);

    expect(screen.queryByText(/home\.heroKickerCount/)).not.toBeInTheDocument();
    expect(screen.queryByText("·")).not.toBeInTheDocument();
    expect(screen.getByText("home.heroLocationEverywhere")).toBeInTheDocument();
  });

  it("omits the count while loading — never a skeleton, never a premature 0", () => {
    mockHeroEvents = { count: 0, isCapped: false, isLoading: true, hasCoords: false };
    render(<HomeHero />);

    expect(screen.queryByText(/home\.heroKickerCount/)).not.toBeInTheDocument();
    expect(screen.queryByText("·")).not.toBeInTheDocument();
    expect(document.querySelector(".hh-skel")).toBeNull();
    expect(screen.getByText("home.heroLocationEverywhere")).toBeInTheDocument();
  });

  // ── Kicker venues: second segment, same "no number, no band" gate ────────

  it("renders the venues segment alone when only the venue count is real", () => {
    mockHeroEvents = loaded(0);
    mockPlaceCount = venues(12);
    render(<HomeHero />);

    expect(kickerSegments()).toEqual([
      "01.",
      "home.heroLocationEverywhere",
      "·",
      "home.heroKickerVenues(count=12)",
    ]);
    expect(screen.queryByText(/home\.heroKickerCount/)).not.toBeInTheDocument();
    expect(screen.getByText("·")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the events segment alone when only the event count is real", () => {
    mockHeroEvents = loaded(3);
    mockPlaceCount = venues(0);
    render(<HomeHero />);

    expect(kickerSegments()).toEqual([
      "01.",
      "home.heroLocationEverywhere",
      "·",
      "home.heroKickerCount(count=3)",
    ]);
    expect(screen.queryByText(/home\.heroKickerVenues/)).not.toBeInTheDocument();
  });

  it("renders venues THEN events, with exactly one separator between them", () => {
    mockHeroEvents = loaded(3, true);
    mockPlaceCount = venues(12);
    render(<HomeHero coords={{ lat: 36.16, lng: -86.78 }} />);

    expect(kickerSegments()).toEqual([
      "01.",
      "home.heroLocationNearYou",
      "·",
      "home.heroKickerVenues(count=12)",
      "·",
      "home.heroKickerCount(count=3)",
    ]);
    const separators = screen.getAllByText("·");
    expect(separators).toHaveLength(2);
    for (const sep of separators) {
      expect(sep).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("keeps the venues segment ahead of the capped events string too", () => {
    mockHeroEvents = loaded(50);
    mockPlaceCount = venues(1);
    render(<HomeHero />);

    expect(kickerSegments()).toEqual([
      "01.",
      "home.heroLocationEverywhere",
      "·",
      "home.heroKickerVenues(count=1)",
      "·",
      "home.heroKickerCountCapped(count=50)",
    ]);
  });

  it("collapses to the bare location label when neither count is real", () => {
    mockHeroEvents = loaded(0);
    mockPlaceCount = venues(0);
    render(<HomeHero />);

    expect(kickerSegments()).toEqual(["01.", "home.heroLocationEverywhere"]);
    expect(screen.queryByText("·")).not.toBeInTheDocument();
  });

  it("omits the venues segment while it loads even though events are ready — no zero, no skeleton", () => {
    mockHeroEvents = loaded(3);
    mockPlaceCount = { count: 0, isLoading: true };
    render(<HomeHero />);

    expect(kickerSegments()).toEqual([
      "01.",
      "home.heroLocationEverywhere",
      "·",
      "home.heroKickerCount(count=3)",
    ]);
    expect(screen.queryByText(/home\.heroKickerVenues/)).not.toBeInTheDocument();
    expect(document.querySelector(".hh-skel")).toBeNull();
  });

  it("binds each separator to its label so a wrap never strands a '·' at a line end", () => {
    mockHeroEvents = loaded(3);
    mockPlaceCount = venues(12);
    render(<HomeHero />);

    // Every separator lives INSIDE a segment wrapper, next to its label.
    for (const sep of screen.getAllByText("·")) {
      const seg = sep.parentElement;
      expect(seg).toHaveClass("hh-kicker-seg");
      expect(seg?.children).toHaveLength(2);
      expect(seg?.children[0]).toBe(sep);
    }
    // ...and the wrapper refuses to break internally.
    const css = document.querySelector("style")?.innerHTML ?? "";
    expect(css).toMatch(/\.hh-kicker-seg\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.hh-kicker-seg\s*\{[^}]*display:\s*inline-flex/);
  });

  it("omits the venues segment while it loads even if a stale count is > 0", () => {
    // Belt and braces: the gate is `!isLoading && count > 0`, not `count > 0`.
    mockHeroEvents = loaded(0);
    mockPlaceCount = { count: 12, isLoading: true };
    render(<HomeHero />);

    expect(kickerSegments()).toEqual(["01.", "home.heroLocationEverywhere"]);
  });

  it("the catalogs' venues plural reads correctly for one and many in both locales", () => {
    const en = createTranslator("en", enMessages);
    const es = createTranslator("es", esMessages);

    expect(en.t("home.heroKickerVenues", { count: 1 })).toBe("1 place");
    expect(en.t("home.heroKickerVenues", { count: 12 })).toBe("12 places");
    // "lugares" — the word the hero's own search object already uses
    // (search.searchEventsArtistsVenues → "Buscar eventos, artistas, lugares...").
    expect(es.t("home.heroKickerVenues", { count: 1 })).toBe("1 lugar");
    expect(es.t("home.heroKickerVenues", { count: 12 })).toBe("12 lugares");
  });

  it("the catalogs' plural message reads correctly for one and many in both locales", () => {
    const en = createTranslator("en", enMessages);
    const es = createTranslator("es", esMessages);

    expect(en.t("home.heroKickerCount", { count: 1 })).toBe("1 event this week");
    expect(en.t("home.heroKickerCount", { count: 12 })).toBe("12 events this week");
    expect(es.t("home.heroKickerCount", { count: 1 })).toBe("1 evento esta semana");
    expect(es.t("home.heroKickerCount", { count: 12 })).toBe("12 eventos esta semana");
    expect(en.t("home.heroKickerCountCapped", { count: 50 })).toBe("50+ events this week");
    expect(es.t("home.heroKickerCountCapped", { count: 50 })).toBe("50+ eventos esta semana");
  });

  // ── Search trigger ───────────────────────────────────────────────────────

  it("renders the search trigger as a labelled button with the test id", () => {
    render(<HomeHero />);

    const el = trigger();
    expect(el).toHaveAttribute("role", "button");
    expect(el).toHaveAttribute("tabindex", "0");
    expect(el).toHaveAttribute("aria-label", "search.searchEventsArtistsVenues");
    expect(
      screen.getByRole("button", { name: "search.searchEventsArtistsVenues" }),
    ).toBe(el);
  });

  it("opens Spotlight on click", async () => {
    const user = userEvent.setup();
    render(<HomeHero />);

    await user.click(trigger());
    expect(openSpotlightMock).toHaveBeenCalledTimes(1);
  });

  it("opens Spotlight on Enter", async () => {
    const user = userEvent.setup();
    render(<HomeHero />);

    trigger().focus();
    await user.keyboard("{Enter}");
    expect(openSpotlightMock).toHaveBeenCalledTimes(1);
  });

  it("opens Spotlight on Space", async () => {
    const user = userEvent.setup();
    render(<HomeHero />);

    trigger().focus();
    await user.keyboard(" ");
    expect(openSpotlightMock).toHaveBeenCalledTimes(1);
  });

  it("shows the placeholder, or the consumer slot's last query when there is one", () => {
    const { unmount } = render(<HomeHero />);
    expect(trigger()).toHaveTextContent("search.searchEventsArtistsVenues");
    unmount();

    mockConsumerQuery = "basement show";
    render(<HomeHero />);
    expect(trigger()).toHaveTextContent("basement show");
  });

  it("carries the visible query in the accessible name (WCAG 2.5.3)", () => {
    mockConsumerQuery = "basement show";
    render(<HomeHero />);

    const el = screen.getByRole("button", {
      name: "search.searchEventsArtistsVenues — basement show",
    });
    expect(el).toBe(trigger());
    expect(el).toHaveAccessibleName(expect.stringContaining("basement show"));
  });

  // ── Chips ────────────────────────────────────────────────────────────────

  it("links the first six browsable categories, and nothing else, inside a labelled group", () => {
    mockCategories = categoriesLoaded(8);
    render(<HomeHero />);

    const links = within(chipGroup()).getAllByRole("link");
    expect(links).toHaveLength(6);
    for (let i = 0; i < 6; i += 1) {
      expect(links[i]).toHaveAttribute("href", `/events/category/slug-${i + 1}`);
      expect(links[i]).toHaveTextContent(`Category ${i + 1}`);
    }
    expect(screen.queryByText("Category 7")).not.toBeInTheDocument();
  });

  it("has no House shows chip in the row (it lives in the footer)", () => {
    render(<HomeHero />);

    const hrefs = within(chipGroup())
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/house-shows");
    expect(
      screen.queryByRole("link", { name: "home.heroChipHouseShows" }),
    ).toBeNull();
  });

  it("offers the one category with something even when it sorts past the first six (production shape)", () => {
    // Production 2026-10-14: 12 active categories, only `open-mics`
    // (sortOrder 9) lists events. The full list's first six are all empty;
    // the hero must show open-mics alone, not those six.
    mockAllCategories = categoriesLoaded(12);
    mockCategories = {
      categories: [
        { id: "cat-open-mics", slug: "open-mics", name: "Standup Open Mic" },
      ],
      isLoading: false,
      isError: false,
    };
    render(<HomeHero />);

    const links = within(chipGroup()).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/events/category/open-mics");
    expect(links[0]).toHaveTextContent("Standup Open Mic");
    expect(screen.queryByText("Category 1")).not.toBeInTheDocument();
  });

  describe("chip links follow the page's language (spanish-seo FR-006)", () => {
    const twoCategories = (): UseCategoryListResult => ({
      categories: [
        {
          id: "cat-music",
          slug: "music",
          name: "Música",
          slugs: { en: "music", es: "musica" },
        },
        // No Spanish slug: its /es/ page lives at the English slug.
        {
          id: "cat-trivia",
          slug: "trivia",
          name: "Trivia",
          slugs: { en: "trivia" },
        },
      ],
      isLoading: false,
      isError: false,
    });

    it("links to the Spanish category pages on /es", () => {
      mockPathname = "/es";
      mockCategories = twoCategories();
      render(<HomeHero />);

      const hrefs = within(chipGroup())
        .getAllByRole("link")
        .map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual([
        "/es/eventos/categoria/musica",
        "/es/eventos/categoria/trivia",
      ]);
    });

    it("keeps the English category pages on /, whatever slugs exist", () => {
      mockCategories = twoCategories();
      render(<HomeHero />);

      const hrefs = within(chipGroup())
        .getAllByRole("link")
        .map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual([
        "/events/category/music",
        "/events/category/trivia",
      ]);
    });
  });

  it("renders no chip group at all while categories load (no skeleton, no empty group)", () => {
    mockCategories = { categories: [], isLoading: true, isError: false };
    render(<HomeHero />);

    expect(chipGroupQuery()).toBeNull();
    expect(screen.queryByRole("link", { name: "home.heroChipHouseShows" })).toBeNull();
    expect(document.querySelector(".hh-skel")).toBeNull();
  });

  it("renders no chip group when the category list is empty", () => {
    mockCategories = { categories: [], isLoading: false, isError: false };
    render(<HomeHero />);

    expect(chipGroupQuery()).toBeNull();
  });

  it("chips are links, never tabs or buttons", () => {
    render(<HomeHero />);

    const group = chipGroup();
    expect(within(group).queryAllByRole("tab")).toHaveLength(0);
    expect(within(group).queryAllByRole("button")).toHaveLength(0);
  });

  it("chips wrap — the CSS never declares a horizontal scroller (D-138)", () => {
    render(<HomeHero />);

    const css = document.querySelector("style")?.innerHTML ?? "";
    expect(css).toMatch(/\.hh-chips\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).not.toMatch(/\.hh-chips\s*\{[^}]*overflow-x/);
  });

  it("chips rest on the ink $borderColor edge, not the soft rgba one", () => {
    render(<HomeHero />);

    const css = document.querySelector("style")?.innerHTML ?? "";
    expect(css).toMatch(
      /\.hh-chip\s*\{[^}]*border:\s*1px solid var\(--borderColor,\s*#211C16\)/,
    );
    expect(css).not.toMatch(/\.hh-chip\s*\{[^}]*borderColorSoft/);
  });

  // ── No rail, no CTAs ─────────────────────────────────────────────────────

  it("has no rail, no stat, no What's on list, and no CTAs", () => {
    mockHeroEvents = loaded(5);
    render(<HomeHero />);

    expect(document.querySelector(".hh-rail")).toBeNull();
    expect(document.querySelector(".hh-panel")).toBeNull();
    expect(document.querySelector(".hh-stat-num")).toBeNull();
    expect(screen.queryByText("home.heroWhatsOn")).not.toBeInTheDocument();
    expect(screen.queryByText(/home\.heroStat/)).not.toBeInTheDocument();
    expect(screen.queryByText(/home\.heroCta/)).not.toBeInTheDocument();
    // The only button on the surface is the search trigger.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("does not compete with the page h1 — no other headings in the hero", () => {
    render(<HomeHero />);

    const section = document.querySelector(".hh-section");
    expect(section?.querySelectorAll("h2, h3, h4, h5, h6")).toHaveLength(0);
  });

  it("declares every fr track as minmax(0, Nfr) (D-133)", () => {
    render(<HomeHero />);

    const css = document.querySelector("style")?.innerHTML ?? "";
    const tracks = css.match(/grid-template-columns:[^;]+/g) ?? [];
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      expect(track).toMatch(/minmax\(0,\s*[\d.]+fr\)/);
      // Strip every sanctioned minmax(0, Nfr) — any `fr` left over is bare.
      const bare = track.replace(/minmax\(0,\s*[\d.]+fr\)/g, "");
      expect(bare).not.toMatch(/fr/);
    }
  });
});
