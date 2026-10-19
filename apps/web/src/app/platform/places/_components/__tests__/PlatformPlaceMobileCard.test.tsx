import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => {
    const dictionary: Record<string, string> = {
      "admin.ppVerified": "Verified",
      "admin.ppPending": "Pending",
      "admin.ppUnverified": "Unverified",
      "admin.ppRejected": "Rejected",
      "admin.ppListed": "Listed",
      "admin.ppUnlisted": "Unlisted",
    };
    return dictionary[key] ?? key;
  },
}));

import {
  PlatformPlaceMobileCard,
  buildLocationString,
} from "../PlatformPlaceMobileCard";
import type { PlatformPlaceRow } from "../types";

const baseRow: PlatformPlaceRow = {
  placeId: "place-1",
  name: "The Velvet Room",
  formattedAddress: "123 Main St, Portland, OR",
  city: "Portland",
  region: "OR",
  countryCode: "US",
  capacity: 250,
  status: "ACTIVE",
  verificationStatus: "PENDING",
  ownerCount: 2,
  listedInDirectory: true,
  publicPath: null,
};

describe("PlatformPlaceMobileCard", () => {
  it("renders name, verification badge, location, owners, capacity, and directory badge", () => {
    render(<PlatformPlaceMobileCard row={baseRow} />);

    expect(screen.getByText("The Velvet Room")).toBeInTheDocument();
    // PENDING uses the same info tone as the table column.
    expect(screen.getByText("Pending")).toHaveAttribute("data-tone", "info");
    expect(screen.getByText("Portland, OR, US")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByText("Listed")).toHaveAttribute("data-tone", "success");
  });

  it("tones rejected/unlisted places and omits missing capacity", () => {
    render(
      <PlatformPlaceMobileCard
        row={{
          ...baseRow,
          verificationStatus: "REJECTED",
          listedInDirectory: false,
          capacity: null,
        }}
      />,
    );

    expect(screen.getByText("Rejected")).toHaveAttribute(
      "data-tone",
      "danger",
    );
    expect(screen.getByText("Unlisted")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(screen.queryByText("250")).not.toBeInTheDocument();
  });

  it("buildLocationString falls back to formattedAddress and then null", () => {
    expect(
      buildLocationString({
        city: null,
        region: null,
        countryCode: null,
        formattedAddress: "456 Side St, Salem, OR",
      }),
    ).toBe("456 Side St, Salem, OR");

    expect(
      buildLocationString({
        city: null,
        region: null,
        countryCode: null,
        formattedAddress: null,
      }),
    ).toBeNull();
  });
});
