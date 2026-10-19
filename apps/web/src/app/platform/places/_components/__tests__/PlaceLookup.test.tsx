import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    [key: string]: unknown;
  }) =>
    React.createElement(
      "div",
      {
        onClick: onPress,
        // Pass through the web-only a11y props (role/tabIndex/onKeyDown)
        // so keyboard activation is actually exercised.
        role: rest.role as string | undefined,
        tabIndex: rest.tabIndex as number | undefined,
        onKeyDown: rest.onKeyDown as
          | ((e: React.KeyboardEvent) => void)
          | undefined,
        "data-testid": rest["data-testid"] as string | undefined,
      },
      children,
    );
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("lucide-react", () => ({
  MapPin: () => <span data-icon="map-pin" />,
  SearchX: () => <span data-icon="search-x" />,
}));

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Spinner: () => <span data-testid="lookup-spinner" />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string, args?: Record<string, unknown>) => {
    const dictionary: Record<string, string> = {
      "admin.ppVerified": "Verified",
      "admin.ppPending": "Pending",
      "admin.ppUnverified": "Unverified",
      "admin.ppRejected": "Rejected",
      "admin.ppLookupPlaceholder": "Find a place by name or slug",
      "admin.ppLookupHint":
        "Search any place by name or slug to review or waive it.",
      "admin.ppLookupNoResults": `No places match "${String(args?.query ?? "")}"`,
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/components/AdminTableParts", () => ({
  SearchBar: ({
    value,
    onChangeText,
    placeholder,
    testId,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    placeholder?: string;
    testId?: string;
  }) => (
    <input
      aria-label={placeholder}
      data-testid={testId}
      value={value}
      onChange={(e) => onChangeText(e.target.value)}
    />
  ),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String((err as Error)?.message ?? err),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    platform: {
      listPlaces: { useQuery: (...args: unknown[]) => useQueryMock(...args) },
    },
  },
}));

import { PlaceLookup } from "../PlaceLookup";
import type { PlatformPlaceRow } from "../types";

const row = (overrides: Partial<PlatformPlaceRow> = {}): PlatformPlaceRow => ({
  placeId: "place-1",
  name: "The Basement",
  formattedAddress: "123 Main St",
  city: "Nashville",
  region: "TN",
  countryCode: "US",
  capacity: 250,
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
  ownerCount: 1,
  listedInDirectory: true,
  publicPath: null,
  ...overrides,
});

/** Type the input and let the 300ms debounce settle. */
function typeAndSettle(value: string) {
  fireEvent.change(screen.getByTestId("platform-place-lookup-input"), {
    target: { value },
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe("PlaceLookup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the hint and fires no query before the minimum query length", () => {
    render(<PlaceLookup onSelectPlace={vi.fn()} />);

    expect(
      screen.getByText(
        "Search any place by name or slug to review or waive it.",
      ),
    ).toBeInTheDocument();
    // Rendered, but disabled — react-query must not issue the request.
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );

    typeAndSettle("b");

    expect(useQueryMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("debounces: keystrokes do not enable the query until the delay elapses", () => {
    render(<PlaceLookup onSelectPlace={vi.fn()} />);

    fireEvent.change(screen.getByTestId("platform-place-lookup-input"), {
      target: { value: "base" },
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(useQueryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: "base" }),
      expect.anything(),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(useQueryMock).toHaveBeenCalledWith(
      { query: "base", limit: 8, offset: 0 },
      expect.objectContaining({ enabled: true }),
    );
  });

  it("caps the request at 8 results and trims the term", () => {
    render(<PlaceLookup onSelectPlace={vi.fn()} />);

    typeAndSettle("  the-basement  ");

    expect(useQueryMock).toHaveBeenCalledWith(
      { query: "the-basement", limit: 8, offset: 0 },
      expect.objectContaining({ enabled: true }),
    );
  });

  it("renders results and hands the selected place back to the caller", () => {
    const onSelectPlace = vi.fn();
    useQueryMock.mockReturnValue({
      data: { places: [row()] },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    render(<PlaceLookup onSelectPlace={onSelectPlace} />);
    typeAndSettle("basement");

    expect(screen.getByText("The Basement")).toBeInTheDocument();
    // Location is the whole secondary line. It used to lead with the venue's
    // `Place.slug` — a DIRECTORY key nothing routed on, since deprecated and
    // no longer minted, so on any recent venue it rendered blank.
    expect(screen.getByText("Nashville, TN, US")).toBeInTheDocument();
    expect(screen.getByText("Unverified")).toHaveAttribute(
      "data-tone",
      "warning",
    );

    fireEvent.click(screen.getByText("The Basement"));
    expect(onSelectPlace).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: "place-1" }),
    );
  });

  it("activates a result from the keyboard", () => {
    const onSelectPlace = vi.fn();
    useQueryMock.mockReturnValue({
      data: { places: [row()] },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    render(<PlaceLookup onSelectPlace={onSelectPlace} />);
    typeAndSettle("basement");

    const result = screen.getAllByRole("button")[0];
    fireEvent.keyDown(result, { key: "Enter" });
    expect(onSelectPlace).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state naming the query when nothing matches", () => {
    useQueryMock.mockReturnValue({
      data: { places: [] },
      isLoading: false,
      isFetching: false,
      error: null,
    });

    render(<PlaceLookup onSelectPlace={vi.fn()} />);
    typeAndSettle("zzzz");

    expect(screen.getByText('No places match "zzzz"')).toBeInTheDocument();
  });

  it("surfaces a query error instead of an empty state", () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error("STAFF_ONLY"),
    });

    render(<PlaceLookup onSelectPlace={vi.fn()} />);
    typeAndSettle("basement");

    expect(screen.getByText("STAFF_ONLY")).toBeInTheDocument();
    expect(screen.queryByText(/No places match/)).not.toBeInTheDocument();
  });

  it("shows the spinner while the request is in flight", () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
    });

    render(<PlaceLookup onSelectPlace={vi.fn()} />);
    typeAndSettle("basement");

    expect(screen.getByTestId("lookup-spinner")).toBeInTheDocument();
  });
});
