/**
 * The category and city×category pages' "Home" buttons go home in the page's
 * language (spanish-seo FR-006): `/es` from the Spanish twin, `/` from the
 * English page. Decided by the URL, never the viewer's language.
 *
 * Tamagui and the design system are stubbed to plain elements; only the
 * navigation target is under test.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let pathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname,
}));

vi.mock("tamagui", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { YStack: Box, XStack: Box, styled: () => Box };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onPress}>
      {children}
    </button>
  ),
  // Renders its empty state, so the second Home button is in the tree.
  EventGrid: ({ renderEmptyState }: { renderEmptyState?: () => ReactNode }) => (
    <div>{renderEmptyState?.()}</div>
  ),
  Lineup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LineupRow: () => null,
  ViewToggle: () => null,
  useLocale: () => "es",
  useFormatters: () => ({ locale: "es" }),
  useListingPriceWords: () => ({ seeDetails: "See details" }),
  listingPriceText: () => undefined,
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/saves/useEventSaves", () => ({
  useSavedEventSummaries: (events: unknown[]) => ({
    events,
    onFavoriteToggle: vi.fn(),
  }),
}));
vi.mock("@/components/saves/SaveHeart", () => ({ SaveHeart: () => null }));

vi.mock("@/app/_components/home/useCategoryBrowse", () => ({
  useCategoryList: () => ({ categories: [], isLoading: false, isError: false }),
  useCategoryEvents: () => ({ events: [], isLoading: false, isError: false }),
}));

import { CategoryPage } from "../_components/CategoryPage";
import { GeoCategoryPage } from "../[city]/_components/GeoCategoryPage";

/** The header's "← Home" and the empty state's "Back to home". */
const pressEveryHomeButton = () => {
  const buttons = screen.getAllByRole("button", { name: "common.backToHome" });
  for (const button of buttons) fireEvent.click(button);
  return buttons.length;
};

describe.each([
  {
    name: "CategoryPage",
    es: "/es/eventos/categoria/musica",
    en: "/events/category/music",
    ui: () => <CategoryPage categorySlug="music" />,
  },
  {
    name: "GeoCategoryPage",
    es: "/es/eventos/categoria/musica/nashville-tn",
    en: "/events/category/music/nashville-tn",
    ui: () => (
      <GeoCategoryPage
        events={[]}
        categoryName="Music"
        cityLabel="Nashville"
        count={0}
      />
    ),
  },
])("$name Home buttons", ({ es, en, ui }) => {
  beforeEach(() => {
    push.mockClear();
  });

  it("go to /es from the Spanish twin", () => {
    pathname = es;
    render(ui());

    const pressed = pressEveryHomeButton();
    expect(pressed).toBe(2);
    expect(push.mock.calls).toEqual([["/es"], ["/es"]]);
  });

  it("go to / from the English page", () => {
    pathname = en;
    render(ui());

    pressEveryHomeButton();
    expect(push.mock.calls).toEqual([["/"], ["/"]]);
  });
});
