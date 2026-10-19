import { fireEvent, screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { MenuButton } from "../forms/MenuButton";

const items = (onA = vi.fn(), onB = vi.fn()) => [
  { label: "Apple Wallet", onSelect: onA, testId: "apple" },
  { label: "Google Wallet", onSelect: onB, testId: "google" },
];

describe("MenuButton", () => {
  // Unlike the group's seam geometry, this is all real DOM — attributes and
  // events — so jsdom can see it honestly.

  it("starts closed and announces that it opens a menu", () => {
    renderWithProvider(
      <MenuButton label="Add to wallet" items={items()} testId="trigger" />,
    );
    const trigger = screen.getByTestId("trigger");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on press and lists its items", () => {
    renderWithProvider(
      <MenuButton label="Add to wallet" items={items()} testId="trigger" />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByTestId("trigger")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("runs the item's action and closes", () => {
    const onA = vi.fn();
    renderWithProvider(
      <MenuButton label="Add to wallet" items={items(onA)} testId="trigger" />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.click(screen.getByTestId("apple"));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    // Listened for on the document, not the menu: Escape has to work while
    // focus is still on the trigger.
    renderWithProvider(
      <MenuButton label="Add to wallet" items={items()} testId="trigger" />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click outside itself", () => {
    renderWithProvider(
      <>
        <MenuButton label="Add to wallet" items={items()} testId="trigger" />
        <button type="button">Elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not close when the click lands inside it", () => {
    renderWithProvider(
      <MenuButton label="Add to wallet" items={items()} testId="trigger" />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("renders an icon-only trigger with nothing but the glyph inside it", () => {
    // `label=""` used to still emit a ButtonText child AND the frame's gap
    // Spacer beside it, so a 38px square trigger carried 42.56px of content:
    // the icon was the only shrinkable item and got squeezed from 16px to
    // 7.4px, flush against the left border. (Measured in Chrome on the admin
    // dashboard calendar toolbar.)
    renderWithProvider(
      <MenuButton
        label=""
        icon={<svg data-testid="glyph" width={16} height={16} />}
        aria-label="More"
        items={items()}
        testId="trigger"
      />,
    );
    const trigger = screen.getByTestId("trigger");
    expect(trigger).toHaveAttribute("aria-label", "More");
    expect(Array.from(trigger.children)).toEqual([
      screen.getByTestId("glyph"),
    ]);
  });

  it("keeps the label and its spacing on a labelled trigger", () => {
    renderWithProvider(
      <MenuButton
        label="Add to wallet"
        icon={<svg data-testid="glyph" width={16} height={16} />}
        items={items()}
        testId="trigger"
      />,
    );
    const trigger = screen.getByTestId("trigger");
    expect(trigger).toHaveTextContent("Add to wallet");
    expect(trigger.children.length).toBeGreaterThan(1);
  });

  it("ignores a disabled item rather than firing it", () => {
    const onA = vi.fn();
    renderWithProvider(
      <MenuButton
        label="Add to wallet"
        testId="trigger"
        items={[
          { label: "Apple Wallet", onSelect: onA, disabled: true, testId: "apple" },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.click(screen.getByTestId("apple"));
    expect(onA).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
