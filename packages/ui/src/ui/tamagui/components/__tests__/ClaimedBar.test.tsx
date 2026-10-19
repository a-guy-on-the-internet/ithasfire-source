import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { ClaimedBar, CLAIMED_BAR_HOT_THRESHOLD } from "../events/ClaimedBar";

const getFill = () => {
  const track = screen.getByRole("progressbar");
  return track.querySelector("div");
};

describe("ClaimedBar", () => {
  it("never renders at 0% (v2 rule)", () => {
    renderWithProvider(<ClaimedBar percent={0} />);
    expect(screen.queryByTestId("claimed-bar")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("never renders a bar that would be captioned '0% claimed' (fractional band)", () => {
    // 0.4% rounds to a "0% claimed" label — suppress at label granularity.
    renderWithProvider(<ClaimedBar percent={0.4} />);
    expect(screen.queryByTestId("claimed-bar")).toBeNull();
  });

  it("never renders for negative or NaN percents", () => {
    const { unmount } = renderWithProvider(<ClaimedBar percent={-12} />);
    expect(screen.queryByTestId("claimed-bar")).toBeNull();
    unmount();

    renderWithProvider(<ClaimedBar percent={Number.NaN} />);
    expect(screen.queryByTestId("claimed-bar")).toBeNull();
  });

  it("uses the accent fill below the hot threshold", () => {
    renderWithProvider(<ClaimedBar percent={CLAIMED_BAR_HOT_THRESHOLD - 1} />);
    expect(getFill()?.className).toContain("_bg-accent");
  });

  it("switches to the support fill at exactly the 80% hot threshold", () => {
    renderWithProvider(<ClaimedBar percent={CLAIMED_BAR_HOT_THRESHOLD} />);
    expect(getFill()?.className).toContain("_bg-support");
  });

  it("stays hot above the threshold and clamps values over 100", () => {
    renderWithProvider(<ClaimedBar percent={140} />);
    expect(getFill()?.className).toContain("_bg-support");

    const track = screen.getByRole("progressbar");
    expect(track).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("100% claimed")).toBeTruthy();
  });

  it("renders the default 'NN% claimed' label", () => {
    renderWithProvider(<ClaimedBar percent={67} />);
    expect(screen.getByText("67% claimed")).toBeTruthy();
  });

  it("accepts a localized label override", () => {
    renderWithProvider(<ClaimedBar percent={67} label="67% reclamado" />);
    expect(screen.getByText("67% reclamado")).toBeTruthy();
    expect(screen.queryByText("67% claimed")).toBeNull();
  });

  it("styles the track with the soft border and raised surface", () => {
    renderWithProvider(<ClaimedBar percent={34} />);
    const track = screen.getByRole("progressbar");
    // Tamagui truncates long token names in compiled class names
    // (e.g. `_bg-surfaceRais3231`) — assert on the stable prefix.
    expect(track.className).toContain("_bg-surfaceRais");
    expect(track.className).toMatch(/_btc-borderColor\d/);
    expect(track.className).toContain("_btw-1px");
  });
});
