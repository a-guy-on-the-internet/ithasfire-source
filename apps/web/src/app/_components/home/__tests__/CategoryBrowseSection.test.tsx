import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Structural contract for the category chip row. What IS under test:
 * - the chips are a labelled `tablist` of `tab`s (they select a category in
 *   place) with exactly one `aria-selected` tab, and that selection follows
 *   the tap and drives the events query + the VIEW ALL href;
 * - the row is not a horizontal drag rail (D-138): (a) no react-native
 *   `ScrollView` appears in the tree, and (b) the tablist's styled config
 *   declares `flexWrap: "wrap"` with no `overflowX` of `auto`/`scroll`. The
 *   `styled` mock below forwards the config it is given as data attributes so
 *   that (b) is a real assertion, not a mock echoing itself.
 *
 * What is NOT under test: the vertical rhythm (16px header → chips, 24px
 * chips → grid) or any pixel layout — every Tamagui atom is mocked to a plain
 * <div>, so nothing here lays out. The live Playwright measurement in the
 * implementation report is the evidence for those.
 */

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// The page's URL decides VIEW ALL's language (spanish-seo FR-006).
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

type StyledConfig = {
  flexWrap?: string;
  overflowX?: string;
  overflow?: string;
};

type BoxProps = {
  children?: ReactNode;
  role?: string;
  "aria-label"?: string;
};

vi.mock("tamagui", () => {
  const passthrough = ({ children, role, "aria-label": ariaLabel }: BoxProps) => (
    <div role={role} aria-label={ariaLabel}>
      {children}
    </div>
  );
  // Forward the style config `styled(Base, config)` receives so tests can
  // assert on what the component DECLARED, not on the mock's defaults.
  const styled =
    (_Base: unknown, config?: StyledConfig) =>
    ({ children, role, "aria-label": ariaLabel }: BoxProps) => (
      <div
        role={role}
        aria-label={ariaLabel}
        data-flex-wrap={config?.flexWrap ?? "nowrap"}
        data-overflow-x={config?.overflowX ?? config?.overflow ?? "visible"}
      >
        {children}
      </div>
    );
  return { YStack: passthrough, XStack: passthrough, styled };
});

vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => (
    <div data-testid="rn-scrollview">{children}</div>
  ),
}));

vi.mock("@th/ui", () => ({
  Chip: ({
    children,
    onPress,
    role,
    "aria-selected": ariaSelected,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    role?: string;
    "aria-selected"?: boolean;
  }) => (
    <button
      type="button"
      role={role}
      aria-selected={ariaSelected}
      onClick={() => onPress?.()}
    >
      {children}
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ViewToggle: () => <div data-testid="view-toggle" />,
  EventGrid: ({ testIdBase }: { testIdBase?: string }) => (
    <div data-testid={testIdBase} />
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/saves/useEventSaves", () => ({
  useSavedEventSummaries: (events: unknown[]) => ({
    events,
    onFavoriteToggle: vi.fn(),
  }),
}));

vi.mock("../ViewAllLink", () => ({
  ViewAllLink: ({ href }: { href: string }) => <a href={href}>view all</a>,
}));

const mockUseCategoryEvents = vi.fn();
const BROWSABLE = [
  { slug: "music", name: "Music", slugs: { en: "music", es: "musica" } },
  // No `slugs`: an API from before the field (a deploy window).
  { slug: "nightlife", name: "Nightlife" },
  // No Spanish slug: its /es/ page lives at the English slug.
  { slug: "comedy", name: "Comedy", slugs: { en: "comedy" } },
];
let mockBrowsable: {
  categories: Array<{
    slug: string;
    name: string;
    slugs?: Partial<Record<string, string>>;
  }>;
  isLoading: boolean;
};
vi.mock("../useCategoryBrowse", () => ({
  // The full active list, empty categories included. The section must not
  // read it (owner ruling 2026-10-14: offer only categories with something).
  useCategoryList: () => ({
    categories: [{ slug: "empty-category", name: "Empty Category" }],
    isLoading: false,
  }),
  useBrowseCategoryList: () => mockBrowsable,
  useCategoryEvents: (...args: unknown[]) => mockUseCategoryEvents(...args),
}));

import { CategoryBrowseSection } from "../CategoryBrowseSection";

describe("CategoryBrowseSection", () => {
  beforeEach(() => {
    mockUseCategoryEvents.mockReset();
    mockUseCategoryEvents.mockReturnValue({ events: [], isLoading: false });
    mockBrowsable = { categories: BROWSABLE, isLoading: false };
    mockPathname = "/";
  });

  it("points VIEW ALL at the selected category's page in the page's language", () => {
    mockPathname = "/es";
    render(<CategoryBrowseSection sectionNumber={3} />);
    const viewAll = () => screen.getByRole("link", { name: "view all" });

    // Spanish slug when the category has one.
    expect(viewAll()).toHaveAttribute("href", "/es/eventos/categoria/musica");

    // None (or no `slugs` at all): the English slug under /es/.
    fireEvent.click(screen.getByRole("tab", { name: "Comedy" }));
    expect(viewAll()).toHaveAttribute("href", "/es/eventos/categoria/comedy");
    fireEvent.click(screen.getByRole("tab", { name: "Nightlife" }));
    expect(viewAll()).toHaveAttribute(
      "href",
      "/es/eventos/categoria/nightlife",
    );
  });

  it("keeps VIEW ALL on the English page on /, even with a Spanish slug", () => {
    render(<CategoryBrowseSection sectionNumber={3} />);

    expect(screen.getByRole("link", { name: "view all" })).toHaveAttribute(
      "href",
      "/events/category/music",
    );
  });

  it("offers only the browsable categories, never the full active list", () => {
    render(<CategoryBrowseSection sectionNumber={3} />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Music",
      "Nightlife",
      "Comedy",
    ]);
    expect(
      screen.queryByRole("tab", { name: "Empty Category" }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when no category has anything listed", () => {
    mockBrowsable = { categories: [], isLoading: false };
    const { container } = render(<CategoryBrowseSection sectionNumber={3} />);

    expect(container).toBeEmptyDOMElement();
    expect(mockUseCategoryEvents).toHaveBeenCalledWith(null, 8, undefined);
  });

  it("renders the chips as a labelled tablist with one selected tab", () => {
    render(<CategoryBrowseSection sectionNumber={3} />);

    const tablist = screen.getByRole("tablist", {
      name: "common.browseByCategory",
    });
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    tabs.forEach((tab) => expect(tablist).toContainElement(tab));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Music",
    );
  });

  it("falls back to the first category when a refetch drops the tapped one", () => {
    const { rerender } = render(<CategoryBrowseSection sectionNumber={3} />);
    fireEvent.click(screen.getByRole("tab", { name: "Comedy" }));

    mockBrowsable = {
      categories: BROWSABLE.filter((c) => c.slug !== "comedy"),
      isLoading: false,
    };
    // The section is memo'd and the hook is mocked, so a new prop stands in
    // for the query's re-render.
    rerender(<CategoryBrowseSection sectionNumber={4} />);

    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Music",
    );
    expect(mockUseCategoryEvents).toHaveBeenLastCalledWith(
      "music",
      8,
      undefined,
    );
  });

  it("moves aria-selected to the tapped chip and loads that category", () => {
    render(<CategoryBrowseSection sectionNumber={3} />);

    fireEvent.click(screen.getByRole("tab", { name: "Comedy" }));

    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Comedy",
    );
    expect(mockUseCategoryEvents).toHaveBeenLastCalledWith(
      "comedy",
      8,
      undefined,
    );
    expect(screen.getByRole("link", { name: "view all" })).toHaveAttribute(
      "href",
      "/events/category/comedy",
    );
  });

  it("does not put the chips in a horizontal scroll rail (D-138)", () => {
    render(<CategoryBrowseSection sectionNumber={3} />);

    // (a) no react-native rail wraps the row
    expect(screen.queryByTestId("rn-scrollview")).not.toBeInTheDocument();

    // (b) the tablist itself is declared wrapping, with no horizontal scroll
    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveAttribute("data-flex-wrap", "wrap");
    expect(["auto", "scroll"]).not.toContain(
      tablist.getAttribute("data-overflow-x"),
    );
  });
});
