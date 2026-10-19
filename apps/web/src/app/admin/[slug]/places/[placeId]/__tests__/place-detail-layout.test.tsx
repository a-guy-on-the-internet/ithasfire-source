import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import PlaceDetailLayout from "../layout";

import * as NextNavigation from "next/navigation";

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

const mockedGetPlaceTitleQuery = vi.fn<unknown[], any>(() => ({
  data: undefined,
  isError: false,
  error: null,
}));

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(
    () => `/admin/acme-co/places/${PLACE_ID}/settings`,
  ),
}));

const routerPush = vi.fn();
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: routerPush }),
}));

// Plain-DOM stand-ins so the layout mounts without a TamaguiProvider/theme
// (same technique as AdminShell.test.tsx).
vi.mock("tamagui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("tamagui");
  return {
    ...actual,
    YStack: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
    useTheme: () => ({
      danger: { val: "#B93312" },
      warning: { val: "#F59E0B" },
    }),
  };
});

vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  return {
    ...actual,
    useTranslations: () => (key: string) => key,
    Text: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
    Button: ({
      children,
      onPress,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
    }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getPlaceTitle: {
        useQuery: (...args: unknown[]) =>
          (mockedGetPlaceTitleQuery as any)(...args),
      },
    },
  },
}));

const mockedUseDocumentTitle = vi.fn();
vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitle: (title: string | null | undefined) =>
    mockedUseDocumentTitle(title),
}));

/**
 * `use(params)` unwraps a thenable. A plain `Promise.resolve()` SUSPENDS the
 * first render (React only trusts a tracked promise) — hand React an
 * already-fulfilled thenable so `use()` returns synchronously (same pattern
 * as events/[id]/applications/__tests__/page.test.tsx).
 */
function fulfilledParams(value: { slug: string; placeId: string }) {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
}

const renderLayout = () =>
  render(
    <PlaceDetailLayout
      params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
    >
      <div data-testid="surface-content">Surface</div>
    </PlaceDetailLayout>,
  );

const trpcError = (code: string) => ({
  data: undefined,
  isError: true,
  error: { data: { code }, message: "boom" },
});

describe("PlaceDetailLayout (post tab-bar deletion, FR-203/FR-204)", () => {
  beforeEach(() => {
    routerPush.mockClear();
    mockedUseDocumentTitle.mockClear();
    mockedGetPlaceTitleQuery.mockReset();
    mockedGetPlaceTitleQuery.mockReturnValue({
      data: undefined,
      isError: false,
      error: null,
    });
    vi.mocked(NextNavigation.usePathname).mockReturnValue(
      `/admin/acme-co/places/${PLACE_ID}/settings`,
    );
  });

  it("renders the surface while the title query is loading (old tab layout behaviour)", () => {
    renderLayout();
    expect(screen.getByTestId("surface-content")).toBeInTheDocument();
    // No place name yet → no specific title (falsy skips per useDocumentTitle).
    expect(mockedUseDocumentTitle).toHaveBeenLastCalledWith(null);
  });

  it("sets the FR-204 document title '<Tab> · <Place name>' from the light title query", () => {
    mockedGetPlaceTitleQuery.mockReturnValue({
      data: {
        id: PLACE_ID,
        name: "The Basement",
        slug: "the-basement",
        status: "ACTIVE",
        verification: "VERIFIED",
      },
      isError: false,
      error: null,
    });

    renderLayout();

    expect(screen.getByTestId("surface-content")).toBeInTheDocument();
    expect(mockedUseDocumentTitle).toHaveBeenLastCalledWith(
      "admin.plNavSettings · The Basement",
    );
  });

  it("titles an unknown or missing segment as Settings — the venue's home surface (FR-401)", () => {
    // `/edit` and `/verify` redirect before this layout titles anything, and
    // the bare place URL has no segment at all; both fall back to Settings.
    vi.mocked(NextNavigation.usePathname).mockReturnValue(
      `/admin/acme-co/places/${PLACE_ID}`,
    );
    mockedGetPlaceTitleQuery.mockReturnValue({
      data: {
        id: PLACE_ID,
        name: "The Basement",
        slug: "the-basement",
        status: "ACTIVE",
        verification: "UNVERIFIED",
      },
      isError: false,
      error: null,
    });

    renderLayout();

    expect(mockedUseDocumentTitle).toHaveBeenLastCalledWith(
      "admin.plNavSettings · The Basement",
    );
  });

  it("resolves sub-sub-routes to their owning surface label (layout/designer → Seat layout)", () => {
    vi.mocked(NextNavigation.usePathname).mockReturnValue(
      `/admin/acme-co/places/${PLACE_ID}/layout/designer`,
    );
    mockedGetPlaceTitleQuery.mockReturnValue({
      data: {
        id: PLACE_ID,
        name: "The Basement",
        slug: "the-basement",
        status: "ACTIVE",
        verification: "VERIFIED",
      },
      isError: false,
      error: null,
    });

    renderLayout();

    expect(mockedUseDocumentTitle).toHaveBeenLastCalledWith(
      "admin.plNavSeatLayout · The Basement",
    );
  });

  it("gates a FORBIDDEN title fetch: access card instead of the surface", () => {
    mockedGetPlaceTitleQuery.mockReturnValue(trpcError("FORBIDDEN"));

    renderLayout();

    expect(screen.queryByTestId("surface-content")).toBeNull();
    expect(
      screen.getByText("admin.placeEditAccessDenied"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("admin.placeEditAccessDeniedDescription"),
    ).toBeInTheDocument();
  });

  it("gates a NOT_FOUND title fetch with the not-found card", () => {
    mockedGetPlaceTitleQuery.mockReturnValue(trpcError("NOT_FOUND"));

    renderLayout();

    expect(screen.queryByTestId("surface-content")).toBeNull();
    expect(screen.getByText("admin.placeEditNotFound")).toBeInTheDocument();
    expect(
      screen.getByText("admin.placeEditNotFoundDescription"),
    ).toBeInTheDocument();
  });

  it("shows the generic card (with the error message) for any other failure", () => {
    mockedGetPlaceTitleQuery.mockReturnValue(
      trpcError("INTERNAL_SERVER_ERROR"),
    );

    renderLayout();

    expect(screen.queryByTestId("surface-content")).toBeNull();
    expect(
      screen.getByText("admin.placeEditGenericError"),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("the card's back button routes to the workspace places list", () => {
    mockedGetPlaceTitleQuery.mockReturnValue(trpcError("FORBIDDEN"));

    renderLayout();

    fireEvent.click(
      screen.getByRole("button", { name: /placeEditBackToPlaces/i }),
    );
    expect(routerPush).toHaveBeenCalledWith("/admin/acme-co/places");
  });
});
