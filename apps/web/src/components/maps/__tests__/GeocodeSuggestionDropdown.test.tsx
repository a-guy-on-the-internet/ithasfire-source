import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GeocodingResult } from "@/lib/maps/geocoding";
import { GeocodeSuggestionDropdown } from "../GeocodeSuggestionDropdown";
import { GeocodeStatusHint } from "../GeocodeStatusHint";

const hit = (over: Partial<GeocodingResult>): GeocodingResult => ({
  lat: 36.1,
  lng: -86.7,
  formattedAddress: "2190 Nolensville Pike, Nashville, TN 37211",
  name: null,
  streetLine: "2190 Nolensville Pike",
  locality: "Nashville",
  region: "Tennessee",
  regionCode: "TN",
  countryCode: "US",
  postalCode: "37211",
  ...over,
});

const props = {
  isFetching: false,
  activeIdx: -1,
  onSelect: vi.fn(),
  onHover: vi.fn(),
  dropdownRef: { current: null },
  idPrefix: "loc",
};

describe("GeocodeSuggestionDropdown", () => {
  it("tells two businesses at one address apart by leading with the name", () => {
    render(
      <GeocodeSuggestionDropdown
        {...props}
        suggestions={[
          hit({ name: "Steadfast South" }),
          hit({ name: "Red Bicycle" }),
          hit({ name: "South Side Kitchen and Pub" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Steadfast South");
    expect(rows[1]!.textContent).toContain("Red Bicycle");
    expect(rows[2]!.textContent).toContain("South Side Kitchen and Pub");
    // The street line is still there, under the name.
    expect(rows[0]!.textContent).toContain("2190 Nolensville Pike");
    expect(rows[0]!.textContent).toContain("Nashville, TN, 37211");
  });

  it("renders a nameless hit as it always did", () => {
    render(<GeocodeSuggestionDropdown {...props} suggestions={[hit({})]} />);
    expect(screen.getByRole("option").textContent).toBe(
      "2190 Nolensville PikeNashville, TN, 37211",
    );
  });

  it("ignores the POI name when showPoiName is off (billing address)", () => {
    render(
      <GeocodeSuggestionDropdown
        {...props}
        showPoiName={false}
        suggestions={[hit({ name: "Steadfast South" })]}
      />,
    );
    expect(screen.getByRole("option").textContent).not.toContain("Steadfast");
  });

  it("shows Searching… while fetching and nothing when idle", () => {
    const { rerender, container } = render(
      <GeocodeSuggestionDropdown {...props} suggestions={[]} isFetching />,
    );
    expect(screen.getByRole("listbox").textContent).toBe("Searching…");
    rerender(<GeocodeSuggestionDropdown {...props} suggestions={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("GeocodeStatusHint", () => {
  const hintProps = {
    noResultsText: "No matches",
    errorText: "Lookup failed",
    idPrefix: "loc",
  };
  it("keeps one live region mounted and shows the line in flow", () => {
    const { rerender } = render(
      <GeocodeStatusHint {...hintProps} status={null} />,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    rerender(<GeocodeStatusHint {...hintProps} status="error" />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Lookup failed");
    expect(screen.getByTestId("loc-hint").textContent).toBe("Lookup failed");
    rerender(<GeocodeStatusHint {...hintProps} status="no-results" />);
    expect(region.textContent).toBe("No matches");
  });
});
