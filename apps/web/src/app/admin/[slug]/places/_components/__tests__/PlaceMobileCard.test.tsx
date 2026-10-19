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
  // Key-through: these assertions are about WHICH string is chosen, not about
  // its wording (the catalogs have their own parity tests).
  useTranslations: () => (key: string) => key,
}));

import {
  PlaceMobileCard,
  buildFullAddress,
  type PlaceMobileCardRow,
} from "../PlaceMobileCard";

const baseRow: PlaceMobileCardRow = {
  name: "The Velvet Room",
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
  activeVerificationRequestStatus: null,
  capacity: 250,
  formattedAddress: null,
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "Portland",
  region: "OR",
  postalCode: "97201",
  countryCode: "US",
  // ADDRESS PRIVACY (place-address-withholding): `buildFullAddress` is
  // fail-closed, so the "this viewer may see the address" flag has to be
  // explicit on a row that expects a street line.
  locationIsExact: true,
};

describe("PlaceMobileCard", () => {
  it("renders name, status badge, verification badge, address, and capacity", () => {
    render(<PlaceMobileCard row={baseRow} />);

    expect(screen.getByText("The Velvet Room")).toBeInTheDocument();

    const statusBadge = screen.getByText("ACTIVE");
    expect(statusBadge).toHaveAttribute("data-tone", "success");

    // No active request → effective verification mirrors the place flag,
    // with the same tone the table column uses.
    const verificationBadge = screen.getByText("UNVERIFIED");
    expect(verificationBadge).toHaveAttribute("data-tone", "warning");

    expect(
      screen.getByText("123 Main St, Portland, OR 97201, US"),
    ).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
  });

  it("lets an active verification request supersede the place flag", () => {
    render(
      <PlaceMobileCard
        row={{
          ...baseRow,
          status: "ARCHIVED",
          activeVerificationRequestStatus: "IN_REVIEW",
          capacity: null,
        }}
      />,
    );

    expect(screen.getByText("ARCHIVED")).toHaveAttribute(
      "data-tone",
      "danger",
    );
    // IN_REVIEW renders with the underscore replaced, like the table column.
    expect(screen.getByText("IN REVIEW")).toHaveAttribute("data-tone", "info");
    expect(screen.queryByText("250")).not.toBeInTheDocument();
  });

  it("buildFullAddress falls back to formattedAddress and skips TBD parts", () => {
    expect(
      buildFullAddress({
        formattedAddress: "456 Side St, Salem, OR",
        addressLine1: "TBD",
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
        locationIsExact: true,
      }),
    ).toBe("456 Side St, Salem, OR");

    expect(
      buildFullAddress({
        formattedAddress: "TBD",
        addressLine1: "TBD",
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
        locationIsExact: true,
      }),
    ).toBeNull();
  });

  /**
   * ADDRESS PRIVACY. This listing is cross-tenant — it includes globally
   * VERIFIED venues the actor does not own — so a withheld venue's street
   * fields arrive nulled. `buildFullAddress` must not reassemble anything from
   * whatever fragments survive, and the card must say WHY the line is missing.
   */
  it("buildFullAddress returns null for a withheld row, whatever parts it carries", () => {
    expect(
      buildFullAddress({
        formattedAddress: "917 Woodland St, Nashville, TN",
        addressLine1: "917 Woodland St",
        addressLine2: null,
        city: "Nashville",
        region: "TN",
        postalCode: "37206",
        countryCode: "US",
        locationIsExact: false,
      }),
    ).toBeNull();
  });

  it("buildFullAddress fails closed when the flag is absent entirely", () => {
    expect(
      buildFullAddress({
        formattedAddress: "917 Woodland St, Nashville, TN",
        addressLine1: "917 Woodland St",
        addressLine2: null,
        city: "Nashville",
        region: "TN",
        postalCode: "37206",
        countryCode: "US",
      }),
    ).toBeNull();
  });

  it("marks a withheld row as withheld rather than leaving the line blank", () => {
    const { container } = render(
      <PlaceMobileCard row={{ ...baseRow, locationIsExact: false }} />,
    );
    expect(container.textContent).not.toContain("123 Main St");
    expect(container.textContent).toContain("admin.placesAddressWithheld");
  });
});
