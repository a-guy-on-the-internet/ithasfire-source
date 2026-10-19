import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type FC, useState } from "react";

import { renderWithProvider } from "../../../../../test/utils";
import {
  EventSearchAutocomplete,
  type EventSearchSuggestion,
} from "../events/EventSearchAutocomplete";

describe("EventSearchAutocomplete", () => {
  const actClick = async (
    user: ReturnType<typeof userEvent.setup>,
    target: Element,
  ) => {
    await act(async () => {
      await user.click(target);
    });
  };

  const actType = async (
    user: ReturnType<typeof userEvent.setup>,
    target: Element,
    text: string,
  ) => {
    await act(async () => {
      await user.type(target, text);
    });
  };

  const suggestions: EventSearchSuggestion[] = [
    {
      id: "swift-eras",
      title: "Taylor Swift | The Eras Tour",
      subtitle: "Sat, Jul 12 • Levi's Stadium",
      helper: "Santa Clara, CA",
    },
    {
      id: "harry-styles",
      title: "Harry Styles: Love On Tour",
      subtitle: "Tue, Sep 10 • Chase Center",
      helper: "San Francisco, CA",
    },
  ];

  const Controlled: FC<{
    initialQuery?: string;
    overrides?: Partial<React.ComponentProps<typeof EventSearchAutocomplete>>;
  }> = ({ initialQuery = "", overrides }) => {
    const [query, setQuery] = useState(initialQuery);

    return (
      <EventSearchAutocomplete
        query={query}
        onQueryChange={setQuery}
        suggestions={suggestions}
        placeholder="Search events"
        {...overrides}
      />
    );
  };

  it("invokes selection handlers when a suggestion is clicked", async () => {
    const firstSuggestion = suggestions[0]!;
    const handleSelect = vi.fn();
    const handleSubmit = vi.fn();

    renderWithProvider(
      <Controlled
        overrides={{ onSelectSuggestion: handleSelect, onSubmit: handleSubmit }}
      />,
    );

    const user = userEvent.setup();

    const input = screen.getByPlaceholderText("Search events");
    await actClick(user, input);
    await actType(user, input, "tay");

    // The dropdown is rendered async; under full-suite load it can take longer than the default timeout.
    await screen.findByTestId("event-search-dropdown");
    const suggestion = await screen.findByText("Taylor Swift | The Eras Tour");
    await actClick(user, suggestion);

    expect(handleSelect).toHaveBeenCalledWith(firstSuggestion);
    expect(handleSubmit).toHaveBeenCalledWith(firstSuggestion.title);
  }, 15_000);

  it("supports keyboard navigation and submit", async () => {
    const firstSuggestion = suggestions[0]!;
    const handleSelect = vi.fn();

    renderWithProvider(
      <Controlled overrides={{ onSelectSuggestion: handleSelect }} />,
    );

    const user = userEvent.setup();

    const input = screen.getByPlaceholderText("Search events");
    await actClick(user, input);
    await actType(user, input, "tay");

    await screen.findByTestId("event-search-dropdown");

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(handleSelect).toHaveBeenCalledWith(firstSuggestion);
  });

  it("renders an empty state when no suggestions are provided", async () => {
    renderWithProvider(
      <Controlled
        overrides={{
          suggestions: [],
          emptyState: <span>No matches.</span>,
        }}
      />,
    );

    const user = userEvent.setup();

    const input = screen.getByPlaceholderText("Search events");
    await actClick(user, input);
    await actType(user, input, "zzz");

    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("shows the loading state when fetching suggestions", async () => {
    renderWithProvider(<Controlled overrides={{ loading: true }} />);

    const user = userEvent.setup();

    const input = screen.getByPlaceholderText("Search events");
    await actClick(user, input);
    await actType(user, input, "harry");

    // Loading is surfaced as an accessible spinner in the input's trailing
    // accessory (the inline "Searching events…" status row was removed in
    // 007b1e3b in favour of the spinner).
    const trailingAccessory = screen.getByTestId(
      "event-search-trailing-accessory",
    );
    expect(
      within(trailingAccessory).getByLabelText("Loading events"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("event-search-loading-spinner"),
    ).toBeInTheDocument();
  });

  it("renders a compact input without an internal floating label", () => {
    renderWithProvider(<Controlled />);

    expect(
      screen.queryByText("Search events", { selector: "span" }),
    ).toBeNull();
    const input = screen.getByPlaceholderText("Search events");
    expect(input).toHaveStyle({ height: "48px" });
  });

  it("does not open the dropdown before the user types", async () => {
    renderWithProvider(<Controlled />);

    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("Search events");

    await actClick(user, input);

    expect(
      screen.queryByTestId("event-search-dropdown"),
    ).not.toBeInTheDocument();

    await actType(user, input, "t");

    expect(screen.getByTestId("event-search-dropdown")).toBeInTheDocument();
  });
});
