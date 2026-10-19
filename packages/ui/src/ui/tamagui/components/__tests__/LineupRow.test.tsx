import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
import { Lineup, LineupRow } from "../events/LineupRow";

const baseProps = {
  dateLabel: "JUL 24",
  timeLabel: "FRI · 10 PM",
  name: "Midnight Vinyl",
  category: "Music",
  price: "$12",
  testId: "lineup-row",
} as const;

describe("LineupRow", () => {
  it("renders when-block, name, category chip, and price", () => {
    renderWithProvider(<LineupRow {...baseProps} />);

    expect(screen.getByTestId("lineup-row")).toBeTruthy();
    expect(screen.getByText("JUL 24")).toBeTruthy();
    expect(screen.getByText("FRI · 10 PM")).toBeTruthy();
    expect(screen.getByText("Midnight Vinyl")).toBeTruthy();
    expect(screen.getByText("Music")).toBeTruthy();
    expect(screen.getByText("$12")).toBeTruthy();
  });

  it("omits optional tracks when absent", () => {
    renderWithProvider(
      <LineupRow dateLabel="JUL 18" name="Neon Run 5K" testId="lineup-row" />,
    );
    expect(screen.getByText("Neon Run 5K")).toBeTruthy();
    expect(screen.queryByText("Music")).toBeNull();
    expect(screen.queryByText("$12")).toBeNull();
  });

  it("is a labelled link when pressable and fires onPress", () => {
    const onPress = vi.fn();
    renderWithProvider(<LineupRow {...baseProps} onPress={onPress} />);

    const row = screen.getByRole("link", { name: "Midnight Vinyl" });
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders as a real anchor when href is provided (web)", () => {
    renderWithProvider(
      <LineupRow {...baseProps} href="/events/midnight-vinyl" />,
    );

    const row = screen.getByTestId("lineup-row");
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/events/midnight-vinyl");
  });

  it("shifts the name to accent on focus (keyboard parity with hover)", () => {
    renderWithProvider(<LineupRow {...baseProps} onPress={vi.fn()} />);

    const row = screen.getByTestId("lineup-row");
    const name = screen.getByText("Midnight Vinyl");

    fireEvent.focus(row);
    expect(name.className).toContain("_col-accent");

    fireEvent.blur(row);
    expect(name.className).not.toContain("_col-accent");
  });

  it("is not interactive without onPress/href", () => {
    renderWithProvider(<LineupRow {...baseProps} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a muted subtitle under the name", () => {
    renderWithProvider(
      <LineupRow {...baseProps} subtitle="The Basement · Nashville" />,
    );
    expect(screen.getByText("The Basement · Nashville")).toBeTruthy();
  });

  it("renders the when-column only when dateLabel is present", () => {
    // Positive + negative control in one render: two rows, one dated, one not.
    // The date text must appear exactly once — proving the conditional gates
    // on dateLabel, not that the string is trivially absent.
    renderWithProvider(
      <>
        <LineupRow dateLabel="JUL 24" name="Dated Row" testId="dated" />
        <LineupRow name="Dateless Row" subtitle="The Basement" testId="dateless" />
      </>,
    );
    expect(screen.getByText("Dated Row")).toBeTruthy();
    expect(screen.getByText("Dateless Row")).toBeTruthy();
    expect(screen.getAllByText("JUL 24")).toHaveLength(1);
  });

  it("hides the category chip in compact mode but keeps name and price", () => {
    renderWithProvider(<LineupRow {...baseProps} compact />);
    expect(screen.getByText("Midnight Vinyl")).toBeTruthy();
    expect(screen.getByText("$12")).toBeTruthy();
    // Category chip is the first thing to go under density pressure.
    expect(screen.queryByText("Music")).toBeNull();
  });
  // D-099: the container owns the structural rule above the first row, so rows
  // carry a bottom hairline only. Rows owning both edges is what doubled every
  // interior hairline and made call sites hand-patch the first row's border.
  it("wraps rows in a Lineup container that renders them all", () => {
    renderWithProvider(
      <Lineup>
        <LineupRow dateLabel="JUL 24" name="First Row" testId="row-1" />
        <LineupRow dateLabel="JUL 25" name="Second Row" testId="row-2" />
      </Lineup>,
    );
    expect(screen.getByTestId("row-1")).toBeTruthy();
    expect(screen.getByTestId("row-2")).toBeTruthy();
  });

  // Reserving the category track costs a fixed slice of every title's width, so
  // a categoryless list must not pay for a column nothing will fill.
  it("renders the category when present regardless of reserveCategory", () => {
    renderWithProvider(<LineupRow {...baseProps} reserveCategory={false} />);
    expect(screen.getByText("Music")).toBeTruthy();
  });

  it("still renders name and price on a categoryless row that reserves the track", () => {
    renderWithProvider(
      <LineupRow
        dateLabel="JUL 24"
        name="No Category"
        price="$12"
        reserveCategory
        testId="lineup-row"
      />,
    );
    expect(screen.getByText("No Category")).toBeTruthy();
    expect(screen.getByText("$12")).toBeTruthy();
    expect(screen.queryByText("Music")).toBeNull();
  });
});
