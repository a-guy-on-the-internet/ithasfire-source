import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EmbedViewToggle } from "./EmbedViewToggle";

/**
 * The viewer-facing List/Calendar switcher (FR-004). Raw DOM, no providers —
 * the component deliberately uses plain elements + embed-theme tokens so it
 * renders identically inside a third-party iframe.
 */

describe("EmbedViewToggle", () => {
  it("marks the resolved view as pressed", () => {
    render(<EmbedViewToggle value="calendar" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Calendar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("exposes both segments in one labelled group", () => {
    render(<EmbedViewToggle value="list" onChange={() => {}} />);
    const group = screen.getByRole("group", { name: "Browse view" });
    expect(group).toBeInTheDocument();
  });

  it("reports the newly-picked view", async () => {
    const onChange = vi.fn();
    render(<EmbedViewToggle value="list" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(onChange).toHaveBeenCalledWith("calendar");
  });

  it("stays silent when the active segment is clicked again", async () => {
    // Load-bearing: a repeat click must not churn state, which is what keeps
    // the lazily-enabled second query from being re-triggered.
    const onChange = vi.fn();
    render(<EmbedViewToggle value="list" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
