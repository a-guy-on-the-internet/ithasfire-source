import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SearchMapLegend, SearchMapPrivateNote } from "../SearchMapOverlays";

const labels = { group: "Show on map", event: "Events", venue: "Places" };

describe("SearchMapLegend", () => {
  it("renders one pressed toggle per layer, named with its count", () => {
    render(
      <SearchMapLegend
        counts={{ event: 28, venue: 7 }}
        layers={{ event: true, venue: false }}
        onToggle={() => {}}
        labels={labels}
      />,
    );
    expect(screen.getByRole("group", { name: "Show on map" })).toBeTruthy();
    const events = screen.getByRole("button", { name: /Events\s*28/ });
    const venues = screen.getByRole("button", { name: /Places\s*7/ });
    expect(events.getAttribute("aria-pressed")).toBe("true");
    expect(venues.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles the clicked layer", () => {
    const onToggle = vi.fn();
    render(
      <SearchMapLegend
        counts={{ event: 3, venue: 2 }}
        layers={{ event: true, venue: true }}
        onToggle={onToggle}
        labels={labels}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Places/ }));
    expect(onToggle).toHaveBeenCalledWith("venue");
  });

  it("disables a layer with nothing in it, and gives touch surfaces 44px targets", () => {
    render(
      <SearchMapLegend
        counts={{ event: 0, venue: 2 }}
        layers={{ event: true, venue: true }}
        onToggle={() => {}}
        labels={labels}
        touch
      />,
    );
    const events = screen.getByRole("button", { name: /Events/ }) as HTMLButtonElement;
    expect(events.disabled).toBe(true);
    expect(events.style.minHeight).toBe("44px");
  });
});

describe("SearchMapPrivateNote", () => {
  it("is readable text, not map paint", () => {
    render(<SearchMapPrivateNote text="2 places keep their location private and aren’t on the map." />);
    expect(screen.getByText(/2 places keep their location private/)).toBeTruthy();
  });
});
