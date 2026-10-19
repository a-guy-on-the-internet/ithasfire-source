import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SectionJumpChips } from "../SectionJumpChips";

const ITEMS = [
  { id: "balance", label: "Balance" },
  { id: "ledger", label: "Ledger" },
];

describe("SectionJumpChips", () => {
  it("is a labelled nav of real hash links, current one marked", () => {
    render(
      <SectionJumpChips
        items={ITEMS}
        activeId="ledger"
        onSelect={() => true}
        label="Sections on this page"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Sections on this page" });
    expect(nav.className).toBe("th-section-chips");
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#balance",
      "#ledger",
    ]);
    expect(links[0]!.getAttribute("aria-current")).toBeNull();
    expect(links[1]!.getAttribute("aria-current")).toBe("true");
  });

  it("a plain click is handed to onSelect and the default hash jump is cancelled", () => {
    const onSelect = vi.fn(() => true);
    render(
      <SectionJumpChips items={ITEMS} activeId={null} onSelect={onSelect} label="x" />,
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("Ledger").dispatchEvent(event);
    expect(onSelect).toHaveBeenCalledWith("ledger");
    expect(event.defaultPrevented).toBe(true);
  });

  it("a declined select keeps the browser's own hash jump", () => {
    render(
      <SectionJumpChips items={ITEMS} activeId={null} onSelect={() => false} label="x" />,
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("Ledger").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("modifier-clicks are left alone (open in a new tab)", () => {
    const onSelect = vi.fn(() => true);
    render(
      <SectionJumpChips items={ITEMS} activeId={null} onSelect={onSelect} label="x" />,
    );
    fireEvent.click(screen.getByText("Ledger"), { metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
