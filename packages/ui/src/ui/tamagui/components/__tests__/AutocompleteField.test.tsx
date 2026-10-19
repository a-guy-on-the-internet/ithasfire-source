import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { renderWithProvider } from "../../../../../test/utils";
import {
  AutocompleteField,
  type AutocompleteSection,
} from "../forms/AutocompleteField";

describe("AutocompleteField", () => {
  type Suggestion = { id: string; label: string };

  const sections: AutocompleteSection<Suggestion>[] = [
    {
      id: "content",
      content: <span data-testid="custom-content">Quick actions</span>,
    },
  ];

  const Controlled = ({ initialQuery = "" }: { initialQuery?: string }) => {
    const [query, setQuery] = useState(initialQuery);

    return (
      <AutocompleteField
        query={query}
        onQueryChange={setQuery}
        data={{ sections }}
        getSuggestionId={(suggestion) => suggestion.id}
        renderRow={() => null}
        emptyState={<span>No matches</span>}
      />
    );
  };

  it("renders content sections when provided", () => {
    renderWithProvider(<Controlled />);

    expect(
      screen.getByTestId("autocomplete-field-dropdown"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("custom-content")).toBeInTheDocument();
  });

  it("shows content immediately when the query starts populated", () => {
    renderWithProvider(<Controlled initialQuery="prefilled" />);

    expect(
      screen.getByTestId("autocomplete-field-dropdown"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("custom-content")).toBeInTheDocument();
  });
});
