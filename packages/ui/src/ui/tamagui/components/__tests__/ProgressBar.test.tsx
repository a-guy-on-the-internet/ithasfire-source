import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { ProgressBar } from "../feedback/ProgressBar";

describe("ProgressBar", () => {
  it("applies themed track styling", () => {
    renderWithProvider(<ProgressBar value={50} min={0} max={100} />);

    const track = screen.getByRole("progressbar");
    expect(track.className).toMatch(/_bg-[\w-]+/);
    expect(track.getAttribute("data-qa")).toBe("progress-bar");
  });

  it("exposes determinate semantics", () => {
    renderWithProvider(<ProgressBar value={25} min={0} max={100} />);

    const track = screen.getByRole("progressbar");
    expect(track).toHaveAttribute("aria-valuemin", "0");
    expect(track).toHaveAttribute("aria-valuemax", "100");
    expect(track).toHaveAttribute("aria-valuenow", "25");
  });

  it("marks indeterminate variant as busy", () => {
    renderWithProvider(<ProgressBar variant="indeterminate" />);

    const track = screen.getByRole("progressbar");
    expect(track).toHaveAttribute("aria-busy", "true");
    expect(track).not.toHaveAttribute("aria-valuenow");
  });

  it("supports custom fill tokens", () => {
    renderWithProvider(<ProgressBar value={40} fillColor="$success" />);

    const track = screen.getByRole("progressbar");
    const fill = track.querySelector("div");
    expect(fill?.className).toContain("_bg-success");
  });

  it("applies smooth width transitions for determinate updates on web", () => {
    const { rerender } = renderWithProvider(
      <ProgressBar value={10} durationMs={500} />,
    );

    const track = screen.getByRole("progressbar");
    const fill = track.querySelector("div");
    expect(fill?.style.width).toBe("10%");
    expect(fill?.style.transition).toContain("width 500ms");

    rerender(<ProgressBar value={60} durationMs={400} />);
    expect(fill?.style.width).toBe("60%");
    expect(fill?.style.transition).toContain("width 400ms");
  });
});
