import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The row-expansion panel on the admin places table, and specifically what it
 * is allowed to SAY when its read comes back empty.
 *
 * `places.getPlaceDetail` now sits at `canManagePlace` (OWNER/ADMIN/EDITOR, or
 * a verified direct human owner) because it returns the venue's street
 * address, `addressLine2`, `postalCode`, exact coordinates, phone number and
 * ownership list. The TABLE above it is not gated that tightly —
 * `listHumanPlaces` scopes to orgs the actor belongs to in ANY role — so a
 * SCANNER sees the venue row, clicks it, and lands here refused.
 *
 * This panel used to answer every failure with "Could not load place details —
 * please refresh." That is a diagnosis, and for a refusal it is the wrong one:
 * refreshing will never work. Third instance of the same class in this change
 * (after a `?? false` and a missing error branch), so it gets a test.
 *
 * WHAT THIS CANNOT SEE: the design system is mocked away — nothing about
 * layout, the metric tiles, or the panel's real borders.
 */

const mocks = vi.hoisted(() => ({
  detailQuery: vi.fn(),
}));

// Mock only what this file's three assertions actually need. `lucide-react`,
// `verification-config` and `safe-block-url` import cleanly and are never
// reached on these branches — mocking them via a Proxy made the module
// namespace look thenable and hung the run.
vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Spinner: () => <div data-testid="spinner" />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/trpc", () => ({
  trpc: { places: { getPlaceDetail: { useQuery: () => mocks.detailQuery() } } },
}));

import { PlaceDetailPanel } from "../PlaceDetailPanel";

const REFRESH_COPY = /Could not load place details/;

// `canEdit` is a required prop and irrelevant to these three branches — the
// refusal happens before any action row renders. Passed as false so the panel
// never reaches an affordance a refused reader could not use anyway.
const renderPanel = () =>
  render(<PlaceDetailPanel placeId="place-1" slug="acme-co" canEdit={false} />);

describe("PlaceDetailPanel — what it says when the read comes back empty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the refusal on FORBIDDEN, and does NOT tell them to refresh", () => {
    mocks.detailQuery.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: { data: { code: "FORBIDDEN" }, message: "NOT_AUTHORIZED" },
    });

    renderPanel();

    expect(
      screen.getByText("admin.placeEditAccessDeniedDescription"),
    ).toBeInTheDocument();
    // The regression this replaces: advice the reader cannot act on.
    expect(screen.queryByText(REFRESH_COPY)).toBeNull();
    // And never the raw code — `fail()` sets `message` to it.
    expect(screen.queryByText("NOT_AUTHORIZED")).toBeNull();
  });

  it("keeps the refresh advice for a genuine transport failure", () => {
    // Not a blanket swap. A 500 or a dropped connection IS worth retrying, and
    // that copy must survive.
    mocks.detailQuery.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: { data: { code: "INTERNAL_SERVER_ERROR" }, message: "boom" },
    });

    renderPanel();

    expect(screen.getByText(REFRESH_COPY)).toBeInTheDocument();
    expect(
      screen.queryByText("admin.placeEditAccessDeniedDescription"),
    ).toBeNull();
  });

  it("shows the spinner while the read is in flight", () => {
    mocks.detailQuery.mockReturnValue({
      isLoading: true,
      data: undefined,
      error: null,
    });

    renderPanel();

    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByText(REFRESH_COPY)).toBeNull();
  });
});
