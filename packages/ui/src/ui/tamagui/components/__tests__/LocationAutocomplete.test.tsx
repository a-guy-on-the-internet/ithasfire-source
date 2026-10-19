import { fireEvent, screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { colorTokens } from "../../tokens/colors";
import {
  LocationAutocompleteField,
  type LocationAutocompleteFieldProps,
  type LocationAutocompleteSelectionMeta,
  type LocationAutocompleteSuggestion,
} from "../location/LocationAutocomplete";

const hexToCssColor = (hex: string) => {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
};

describe("LocationAutocompleteField", () => {
  const baseSuggestions = [
    {
      id: "pier-17",
      title: "Pier 17",
      subtitle: "New York, NY",
      helper: "Venue",
    },
    {
      id: "union-market",
      title: "Union Market",
      subtitle: "Washington, DC",
      helper: "Market",
    },
  ];

  const setup = (override?: Partial<LocationAutocompleteFieldProps>) =>
    renderWithProvider(
      <LocationAutocompleteField
        query=""
        onQueryChange={() => {}}
        suggestions={baseSuggestions}
        {...override}
      />,
    );

  const focusInput = () => {
    const input = screen.getByPlaceholderText("Location");
    fireEvent.focus(input);
    return input;
  };

  it("does not render suggestions until the user types a query", () => {
    const { rerender } = setup();

    expect(screen.queryByTestId("location-autocomplete-dropdown")).toBeNull();

    rerender(
      <LocationAutocompleteField
        query="pi"
        onQueryChange={() => {}}
        suggestions={baseSuggestions}
      />,
    );

    focusInput();
    expect(
      screen.getByTestId("location-autocomplete-dropdown"),
    ).toBeInTheDocument();
  });

  it("waits to show suggestions until the minimum query length is reached", () => {
    const { rerender } = setup({ minVisibleQueryLength: 3 });

    rerender(
      <LocationAutocompleteField
        query="pi"
        onQueryChange={() => {}}
        suggestions={baseSuggestions}
        minVisibleQueryLength={3}
      />,
    );

    focusInput();

    expect(screen.queryByTestId("location-autocomplete-dropdown")).toBeNull();

    rerender(
      <LocationAutocompleteField
        query="pie"
        onQueryChange={() => {}}
        suggestions={baseSuggestions}
        minVisibleQueryLength={3}
      />,
    );

    focusInput();

    expect(
      screen.getByTestId("location-autocomplete-dropdown"),
    ).toBeInTheDocument();
  });

  it("does not render per-suggestion icons when visible", async () => {
    setup({ query: "pi" });

    focusInput();

    const suggestion = await screen.findByTestId(
      `location-autocomplete-section-locations-suggestion-${baseSuggestions[0]!.id}`,
    );

    expect(
      screen.queryByTestId(
        `location-autocomplete-section-locations-suggestion-${baseSuggestions[0]!.id}-icon`,
      ),
    ).toBeNull();
    expect(suggestion).toBeInTheDocument();
  });

  it("only shows the trailing spinner after a query is entered", () => {
    const { rerender } = setup({ loading: true });

    expect(
      screen.queryByTestId("location-autocomplete-trailing-accessory"),
    ).toBeNull();

    rerender(
      <LocationAutocompleteField
        query="pi"
        onQueryChange={() => {}}
        suggestions={baseSuggestions}
        loading
      />,
    );

    focusInput();

    expect(
      screen.getByTestId("location-autocomplete-trailing-accessory"),
    ).toBeInTheDocument();
  });

  it("uses an opaque dropdown tone for location suggestions", async () => {
    setup({ query: "pi" });

    focusInput();

    const dropdown = await screen.findByTestId(
      "location-autocomplete-dropdown",
    );
    const computed = getComputedStyle(dropdown);
    expect(computed.backgroundColor).toBe("var(--surface)");
  });

  it("connects the dropdown directly to the input without an overlay gap", async () => {
    setup({ query: "pi" });

    focusInput();

    await screen.findByTestId("location-autocomplete-dropdown");
    const input = screen.getByPlaceholderText("Location");

    expect(getComputedStyle(input).borderBottomLeftRadius).toBe("0px");
    expect(getComputedStyle(input).borderBottomRightRadius).toBe("0px");
  });

  it("provides selection metadata when a suggestion is chosen", async () => {
    const onSelect =
      vi.fn<
        (
          suggestion: LocationAutocompleteSuggestion,
          meta: LocationAutocompleteSelectionMeta,
        ) => void
      >();

    setup({ query: "pi", onSelectSuggestion: onSelect });

    focusInput();

    const firstSuggestion = await screen.findByTestId(
      `location-autocomplete-section-locations-suggestion-${baseSuggestions[0]!.id}`,
    );

    fireEvent.click(firstSuggestion);

    expect(onSelect).toHaveBeenCalledWith(baseSuggestions[0], {
      sectionId: "locations",
      sectionIndex: 0,
      index: 0,
    });
  });
});
