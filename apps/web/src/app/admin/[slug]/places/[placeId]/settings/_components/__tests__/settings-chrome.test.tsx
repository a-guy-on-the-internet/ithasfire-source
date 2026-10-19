import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { SettingsSectionIndex } from "../SettingsSectionIndex";
import { SettingsStatusChips } from "../SettingsStatusChips";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

const ITEMS = [
  { targetId: "identity", label: "Identity" },
  { targetId: "location", label: "Location" },
  { targetId: "verification", label: "Verification" },
];

describe("SettingsSectionIndex", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  it("is a NAMED nav landmark of real hash links", () => {
    render(
      <SettingsSectionIndex items={ITEMS} label="Settings sections" kicker="On this page" />,
    );
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#identity",
      "#location",
      "#verification",
    ]);
    // The kicker is decoration beside the landmark's own name.
    expect(screen.getByText("On this page")).toHaveAttribute("aria-hidden", "true");
  });

  it("marks the first section current before anything scrolls (SSR-stable)", () => {
    render(<SettingsSectionIndex items={ITEMS} label="x" kicker="k" />);
    expect(screen.getByRole("link", { name: "Identity" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      screen.getByRole("link", { name: "Location" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("jumps AND moves focus to the section heading, and becomes current", () => {
    const heading = document.createElement("h3");
    heading.id = "verification";
    heading.tabIndex = -1;
    heading.scrollIntoView = vi.fn();
    document.body.appendChild(heading);

    render(<SettingsSectionIndex items={ITEMS} label="x" kicker="k" />);
    fireEvent.click(screen.getByRole("link", { name: "Verification" }));

    expect(heading.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "start" }),
    );
    expect(document.activeElement).toBe(heading);
    expect(window.location.hash).toBe("#verification");
    expect(
      screen.getByRole("link", { name: "Verification" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("falls back to the plain hash jump when the target is not on the page", () => {
    render(<SettingsSectionIndex items={ITEMS} label="x" kicker="k" />);
    const link = screen.getByRole("link", { name: "Location" });
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.click(link)).toBe(true);
  });
});

describe("SettingsStatusChips", () => {
  const renderChips = (
    overrides: Partial<Parameters<typeof SettingsStatusChips>[0]> = {},
  ) =>
    render(
      <SettingsStatusChips
        verificationStatus="VERIFIED"
        listedInDirectory
        pageVisibility="PUBLIC"
        attendeeReviewsPublic={false}
        {...overrides}
      />,
    );

  it("is a labelled list that states each state in WORDS", () => {
    renderChips();
    const list = screen.getByRole("list", { name: "admin.placeSettingsChipsLabel" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "admin.placeVerifVerified",
      "admin.placeEditListedBadge",
      "admin.placeSettingsChipPagePublic",
      "admin.placeSettingsChipRatingsPrivate",
    ]);
  });

  it("tones each chip from its state (the dot is never the only carrier)", () => {
    renderChips({
      verificationStatus: "REJECTED",
      listedInDirectory: false,
      pageVisibility: "UNLISTED",
      attendeeReviewsPublic: true,
    });
    expect(screen.getByTestId("place-settings-chip-verification")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByTestId("place-settings-chip-listing")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByTestId("place-settings-chip-page")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByTestId("place-settings-chip-ratings")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("admin.placeEditNotListedBadge")).toBeInTheDocument();
  });

  it("OMITS the page chip until the page read lands, rather than guessing", () => {
    renderChips({ pageVisibility: null });
    expect(screen.queryByTestId("place-settings-chip-page")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
