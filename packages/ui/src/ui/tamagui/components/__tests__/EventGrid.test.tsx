import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

import { renderWithProvider } from "../../../../../test/utils";
import { elevationTokens, getShadowOverflowPx } from "../../index";
import {
  EventGrid,
  type EventGridFilterState,
  type EventSummary,
  getEventCardMinHeight,
  getEventCardWidthForLayout,
} from "../event-grid";

describe("EventGrid", () => {
  const sampleEvents: EventSummary[] = [
    {
      id: "alpha",
      title: "Jazz at the Harbor",
      date: "2025-07-15",
      venue: "Pier 9 Pavilion",
      priceLabel: "$120",
      badge: { text: "Low fees", tone: "promo" },
      favorite: false,
    },
    {
      id: "bravo",
      title: "Sunset Sessions",
      date: "2025-08-01",
      venue: "Skyline Deck",
      priceLabel: "$85",
    },
    {
      id: "charlie",
      title: "Indie Film Night",
      date: "2025-09-05",
      venue: "Arcade Theater",
      priceLabel: "$42",
    },
    {
      id: "delta",
      title: "Local Makers Fair",
      date: "2025-09-18",
      venue: "Market Hall",
      priceLabel: "Free",
    },
    {
      id: "echo",
      title: "Harvest Wine Walk",
      date: "2025-10-02",
      venue: "Old Town",
      priceLabel: "$65",
    },
  ];

  const originalResizeObserver = globalThis.ResizeObserver;
  let installedResizeObserverMock = false;

  beforeAll(() => {
    if (typeof globalThis.ResizeObserver !== "undefined") {
      return;
    }

    class ResizeObserverMock {
      constructor(_: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
    installedResizeObserverMock = true;
  });

  afterAll(() => {
    if (installedResizeObserverMock) {
      // @ts-expect-error - cleanup test-only global
      delete globalThis.ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("renders events and handles interactions", async () => {
    const user = userEvent.setup();
    const handleCardPress = vi.fn();
    const handleFavoriteToggle = vi.fn();

    renderWithProvider(
      <EventGrid
        events={sampleEvents.slice(0, 2)}
        onCardPress={(event) => handleCardPress(event.id)}
        onFavoriteToggle={(eventId, next, context) =>
          handleFavoriteToggle(eventId, next, context)
        }
      />,
    );

    expect(document.querySelector("[accessibilitystate]")).toBeNull();

    expect(screen.getByTestId("event-grid-card-alpha")).toBeVisible();
    expect(screen.getByTestId("event-grid-card-bravo")).toBeVisible();

    await act(async () => {
      await user.click(screen.getByTestId("event-grid-card-alpha"));
    });
    expect(handleCardPress).toHaveBeenCalledWith("alpha");

    const favoriteButton = within(
      screen.getByTestId("event-grid-card-alpha"),
    ).getByRole("button", {
      name: "Add to favorites",
    });

    await act(async () => {
      await user.click(favoriteButton);
    });
    expect(handleFavoriteToggle).toHaveBeenCalledWith(
      "alpha",
      true,
      expect.objectContaining({ index: 0, sectionId: "default" }),
    );
  });

  it("supports pagination controls", async () => {
    const user = userEvent.setup();

    renderWithProvider(<EventGrid events={sampleEvents} pageSize={2} />);

    expect(
      screen.getByText(/Showing 2 of 5 events \(page 1 of 3\)/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("event-grid-card-alpha")).toBeVisible();
    expect(screen.getByTestId("event-grid-card-bravo")).toBeVisible();
    expect(
      screen.queryByTestId("event-grid-card-charlie"),
    ).not.toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Next" }));
    });

    expect(
      screen.getByText(/Showing 2 of 5 events \(page 2 of 3\)/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("event-grid-card-charlie")).toBeVisible();
    expect(screen.getByTestId("event-grid-card-delta")).toBeVisible();
    expect(
      screen.queryByTestId("event-grid-card-alpha"),
    ).not.toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Previous" }));
    });

    expect(
      screen.getByText(/Showing 2 of 5 events \(page 1 of 3\)/),
    ).toBeInTheDocument();
  });

  it("emits filter updates when search changes", async () => {
    const user = userEvent.setup();
    const handleFilterChange = vi.fn();

    renderWithProvider(
      <EventGrid
        events={sampleEvents.slice(0, 1)}
        filters={{
          enabled: true,
          defaultState: {},
          onChange: handleFilterChange,
        }}
      />,
    );

    const searchInput = screen.getByPlaceholderText("Search events");
    await act(async () => {
      await user.type(searchInput, "jazz");
    });

    expect(handleFilterChange).toHaveBeenCalled();
    const lastCall = handleFilterChange.mock.calls.at(-1)?.[0] as
      | EventGridFilterState
      | undefined;
    expect(lastCall?.search).toBe("jazz");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Clear all" }));
    });
    expect(handleFilterChange).toHaveBeenCalledWith({});
  });

  it("emits filter updates when date range changes", async () => {
    const handleFilterChange = vi.fn();

    renderWithProvider(
      <EventGrid
        events={sampleEvents.slice(0, 1)}
        filters={{
          enabled: true,
          defaultState: {},
          onChange: handleFilterChange,
          dateLimits: { min: "2025-01-01", max: "2025-12-31" },
        }}
      />,
    );

    const startInput = screen.getByLabelText("Start") as HTMLInputElement;

    // The date filters render native <input type="date"> on web (816e77c6),
    // which only accepts ISO YYYY-MM-DD values — anything else is sanitized
    // to an empty string by the browser.
    await act(async () => {
      fireEvent.change(startInput, { target: { value: "2025-06-15" } });
    });

    const lastCall = handleFilterChange.mock.calls.at(-1)?.[0] as
      | EventGridFilterState
      | undefined;
    expect(lastCall?.dateRange?.start).toBe("2025-06-15");
  });

  it("shows a carousel indicator when enabled", () => {
    renderWithProvider(
      <EventGrid
        events={sampleEvents.slice(0, 3)}
        variant="carousel"
        carouselIndicator={{ enabled: true }}
      />,
    );

    expect(
      screen.getByTestId("event-grid-section-default-carousel-indicator"),
    ).toBeInTheDocument();
  });

  // The carousel's ScrollView is `overflow-y: hidden` and box shadows don't
  // count as scrollable overflow, so without this the v2 card shadow was sliced
  // off flush at every card's bottom edge (live on the signed-in home strip).
  it("reserves room on the carousel track for the card shadow", () => {
    renderWithProvider(
      <EventGrid events={sampleEvents.slice(0, 3)} variant="carousel" />,
    );

    const track = screen.getByTestId(
      "event-grid-section-default-carousel-track",
    );
    expect(track).toHaveStyle({
      paddingBottom: `${getShadowOverflowPx(elevationTokens.stub.card)}px`,
    });
  });

  it("supports a flush carousel spacing preset", () => {
    renderWithProvider(
      <EventGrid
        events={sampleEvents.slice(0, 3)}
        variant="carousel"
        spacingPreset="flush"
      />,
    );

    const track = screen.getByTestId(
      "event-grid-section-default-carousel-track",
    );
    expect(track).toHaveStyle({ paddingLeft: "0px", paddingRight: "0px" });
  });

  it("supports a packed carousel spacing preset", () => {
    renderWithProvider(
      <EventGrid
        events={sampleEvents.slice(0, 3)}
        variant="carousel"
        spacingPreset="packed"
      />,
    );

    const section = screen.getByTestId("event-grid-section-default");
    expect(section).toHaveStyle({ gap: "0px" });
  });

  it("keeps carousel cards at a predictable width", () => {
    renderWithProvider(
      <EventGrid events={sampleEvents.slice(0, 3)} variant="carousel" />,
    );

    const track = screen.getByTestId(
      "event-grid-section-default-carousel-track",
    );
    const wrappers = Array.from(track.children) as HTMLElement[];
    expect(wrappers.length).toBeGreaterThan(0);
    const expectedWidth = `${getEventCardWidthForLayout("md", "horizontal")}px`;
    wrappers.forEach((wrapper) => {
      const computedStyle = window.getComputedStyle(wrapper);
      expect(computedStyle.width).toBe(expectedWidth);
      expect(computedStyle.maxWidth).toBe(expectedWidth);
      expect(computedStyle.minWidth).toBe(expectedWidth);
    });
  });

  it("keeps carousel cards at a predictable height", () => {
    renderWithProvider(
      <EventGrid events={sampleEvents.slice(0, 3)} variant="carousel" />,
    );

    const track = screen.getByTestId(
      "event-grid-section-default-carousel-track",
    );
    const wrappers = Array.from(track.children) as HTMLElement[];
    expect(wrappers.length).toBeGreaterThan(0);
    const expectedHeight = `${getEventCardMinHeight("md", "horizontal")}px`;

    wrappers.forEach((wrapper) => {
      const computedStyle = window.getComputedStyle(wrapper);
      expect(computedStyle.minHeight).toBe(expectedHeight);
      expect(computedStyle.maxHeight).toBe(expectedHeight);
    });

    const firstCard = screen.getByTestId("event-grid-card-alpha");
    const cardStyle = window.getComputedStyle(firstCard as HTMLElement);
    expect(cardStyle.minHeight).toBe(expectedHeight);
    expect(cardStyle.maxHeight).toBe(expectedHeight);
  });
});
