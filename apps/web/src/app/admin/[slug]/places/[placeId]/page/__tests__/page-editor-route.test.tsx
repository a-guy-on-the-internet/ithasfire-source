import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import AdminPlacePageEditor from "../page";

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

/**
 * Route-shell smoke for the public-page editor surface.
 *
 * What it exists for: `places.getPlaceForEdit` moved from "any member of an
 * owning org" to `canManagePlace` (OWNER/ADMIN/EDITOR), but the `[placeId]`
 * layout above this route still gates on `getPlaceTitle`, which any member
 * passes. So a SCANNER/VIEWER/FINANCE reaches this route and gets a FORBIDDEN
 * from the read. This page had no error branch at all and fell through to the
 * editor with every value defaulted — an UNVERIFIED chip for a verified venue,
 * and switches rendered off because the payload was missing rather than because
 * the venue is off. These pin the refusal instead.
 */

const mockedGetPlaceForEditQuery = vi.fn<unknown[], any>(() => ({
  data: undefined,
  isLoading: true,
  error: null,
}));

vi.mock("tamagui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("tamagui");
  return {
    ...actual,
    YStack: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
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
    Spinner: () => <div data-testid="spinner" />,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getPlaceForEdit: {
        useQuery: (...args: unknown[]) =>
          (mockedGetPlaceForEditQuery as any)(...args),
      },
    },
  },
}));

vi.mock("@/components/auth/AdminEmailVerificationGate", () => ({
  AdminEmailVerificationGate: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

const profileEditorProbe = vi.fn();
vi.mock("../_components/PlaceProfileEditor", () => ({
  PlaceProfileEditor: (props: Record<string, unknown>) => {
    profileEditorProbe(props);
    return <div data-testid="place-profile-editor" />;
  },
}));

/** Already-fulfilled thenable so `use(params)` returns synchronously. */
function fulfilledParams(value: { slug: string; placeId: string }) {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
}

const renderPage = () =>
  render(
    <AdminPlacePageEditor
      params={fulfilledParams({ slug: "acme-co", placeId: PLACE_ID })}
    />,
  );

describe("AdminPlacePageEditor route shell", () => {
  beforeEach(() => {
    profileEditorProbe.mockClear();
    mockedGetPlaceForEditQuery.mockReset();
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
  });

  it("renders the editor once the place resolves", () => {
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: {
        place: {
          placeId: PLACE_ID,
          verificationStatus: "VERIFIED",
          attendeeReviewsPublic: true,
          viewerCanManageSwitches: true,
        },
      },
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(screen.getByTestId("place-profile-editor")).toBeInTheDocument();
    // The canvas needs only the verification gate now — the review switches
    // it used to be handed live on the venue settings page (FR-401).
    expect(profileEditorProbe).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      slug: "acme-co",
      verificationStatus: "VERIFIED",
    });
  });

  it("shows access denied — NOT a defaulted editor — when the read is FORBIDDEN", () => {
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { data: { code: "FORBIDDEN" }, message: "NOT_RESOURCE_OWNER" },
    });

    renderPage();

    expect(screen.getByText("admin.placeEditAccessDenied")).toBeInTheDocument();
    expect(
      screen.getByText("admin.placeEditAccessDeniedDescription"),
    ).toBeInTheDocument();
    // The regression this replaces: the editor used to render anyway, with a
    // fabricated UNVERIFIED chip and switches off.
    expect(screen.queryByTestId("place-profile-editor")).toBeNull();
    expect(profileEditorProbe).not.toHaveBeenCalled();
  });

  it("falls back to the generic error card on a non-auth failure", () => {
    mockedGetPlaceForEditQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "boom" },
    });

    renderPage();

    expect(screen.getByText("admin.placeEditGenericError")).toBeInTheDocument();
    expect(screen.queryByTestId("place-profile-editor")).toBeNull();
  });

  it("still shows the spinner while the read is in flight", () => {
    renderPage();

    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("place-profile-editor")).toBeNull();
  });
});
