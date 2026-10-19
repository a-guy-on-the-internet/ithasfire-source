/**
 * LocationVisibilitySection — the venue ceiling and the "never reveal" preset.
 *
 * The server is what actually enforces the ceiling (`save-event-shared` clamps
 * inside the save transaction, `buildEventSeo` re-clamps on read). What these
 * tests hold is the part the server cannot do: that an organizer is TOLD, by
 * name, which venue took the decision — instead of meeting a dead radio and
 * concluding the builder is broken.
 */
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";
import { LocationVisibilitySection } from "../LocationVisibilitySection";

const noop = () => {};

const BASE = {
  visibilityMode: "OBSCURED" as const,
  visibilityRadius: 500 as number | null,
  visibilityLabel: "",
  addressRevealPreset: "DAY_BEFORE" as const,
  addressRevealAt: "",
  countryCode: "US",
  onVisibilityModeChange: noop,
  onVisibilityRadiusChange: noop,
  onVisibilityLabelChange: noop,
  onAddressRevealPresetChange: noop,
  onAddressRevealAtChange: noop,
};

const renderSection = (
  props: Partial<Parameters<typeof LocationVisibilitySection>[0]> = {},
) =>
  render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <LocationVisibilitySection {...BASE} {...props} />
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );

describe("the venue ceiling", () => {
  it("leaves the exact-address option available when there is no venue", () => {
    renderSection();
    expect(screen.getByTestId("visibility-mode-exact")).not.toBeDisabled();
    expect(screen.queryByTestId("visibility-venue-ceiling")).toBeNull();
  });

  it("marks exact unavailable and names the venue when it never publishes its address", () => {
    renderSection({
      venueCeiling: { state: "hidden", venueName: "The Bat Cave" },
    });

    const exact = screen.getByTestId("visibility-mode-exact");
    expect(exact).toBeDisabled();
    expect(exact).toHaveAttribute("data-locked-by-venue", "true");
    expect(
      screen.getByTestId("visibility-exact-unavailable"),
    ).toBeInTheDocument();

    const notice = screen.getByTestId("visibility-venue-ceiling");
    expect(notice.textContent).toContain("The Bat Cave");
    expect(notice.textContent).toContain("never publishes its address");
    // The explanation is wired to the locked control, so a screen reader
    // reaching the radio is told why it is unavailable.
    expect(exact).toHaveAttribute("aria-describedby", "visibility-venue-ceiling");
  });

  it("does not fire onVisibilityModeChange when the locked exact card is pressed", () => {
    const onVisibilityModeChange = vi.fn();
    renderSection({
      onVisibilityModeChange,
      venueCeiling: { state: "hidden", venueName: "The Bat Cave" },
    });
    screen.getByTestId("visibility-mode-exact").click();
    expect(onVisibilityModeChange).not.toHaveBeenCalled();
  });

  it("explains the circle case, naming the venue", () => {
    renderSection({
      venueCeiling: {
        state: "area",
        venueName: "The Bat Cave",
        radiusMeters: 1000,
      },
    });
    const notice = screen.getByTestId("visibility-venue-ceiling");
    expect(notice.textContent).toContain("The Bat Cave");
    expect(notice.textContent).toContain("approximate area");
  });

  it("floors the precision slider at the venue's own radius", () => {
    renderSection({
      visibilityRadius: 100,
      venueCeiling: {
        state: "area",
        venueName: "The Bat Cave",
        radiusMeters: 1000,
      },
    });
    const slider = screen.getByTestId(
      "visibility-radius-slider",
    ) as HTMLInputElement;
    // Position 3 is the 1,000 m stop in RADIUS_SLIDER_STOPS (the ladder:
    // 100, 250, 500, 1,000, …).
    expect(Number(slider.min)).toBe(3);
    // …and the displayed value is pulled up to it rather than showing a
    // precision the server would clamp away on save.
    expect(Number(slider.value)).toBeGreaterThanOrEqual(3);
  });

  it("locks exact while the venue's setting is still unknown (fail closed)", () => {
    renderSection({ venueCeiling: { state: "checking" } });
    expect(screen.getByTestId("visibility-mode-exact")).toBeDisabled();
    expect(
      screen.getByTestId("visibility-venue-ceiling").textContent,
    ).toContain("Checking what this place allows");
  });

  it("an ARCHIVED venue keeps exact locked but names the cause, not 'checking … until it answers'", () => {
    renderSection({
      venueCeiling: { state: "checking" },
      placeArchivedName: "The Bat Cave",
    });
    expect(screen.getByTestId("visibility-mode-exact")).toBeDisabled();
    const notice = screen.getByTestId("visibility-venue-ceiling").textContent;
    expect(notice).toContain("The Bat Cave is archived");
    expect(notice).toContain("Pick another place.");
    expect(notice).not.toContain("Checking what this place allows");
  });
});

describe("the 'never reveal' preset", () => {
  it("offers NEVER in the reveal select", () => {
    renderSection();
    const select = screen.getByTestId("address-reveal-preset");
    const values = Array.from(select.querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(values).toContain("NEVER");
  });

  it("spells out the consequence when NEVER is chosen", () => {
    renderSection({ addressRevealPreset: "NEVER" });
    const note = screen.getByTestId("address-reveal-never-consequence");
    expect(note.textContent).toContain("ticket holders included");
  });

  it("shows no consequence note for the ordinary presets", () => {
    renderSection({ addressRevealPreset: "DAY_BEFORE" });
    expect(
      screen.queryByTestId("address-reveal-never-consequence"),
    ).toBeNull();
  });

  it("does not render the custom-datetime field for NEVER", () => {
    // NEVER resolves a null `addressRevealAt` on purpose; asking for a date
    // would contradict the choice.
    renderSection({ addressRevealPreset: "NEVER" });
    expect(screen.queryByTestId("address-reveal-at")).toBeNull();
  });
});

describe("the radius shown is the radius drawn", () => {
  // Metric, so the strings are unambiguous ("DE" is not an imperial country).
  const metric = { countryCode: "DE" };

  it("shows a legacy off-ladder radius at the rung the public circle is drawn at", () => {
    renderSection({ ...metric, visibilityRadius: 700 });
    // The public map draws 700 m at the next rung up, 1 km.
    const preview = screen.getByTestId("visibility-public-preview");
    expect(preview.textContent).toContain("1 km");
    expect(preview.textContent).not.toContain("700");
    const slider = screen.getByTestId("visibility-radius-slider");
    expect(slider.getAttribute("aria-valuetext")).toContain("1 km");
    expect(slider.getAttribute("aria-valuetext")).not.toContain("700");
  });

  it("shows an on-ladder radius as it is", () => {
    renderSection({ ...metric, visibilityRadius: 500 });
    expect(
      screen.getByTestId("visibility-public-preview").textContent,
    ).toContain("500 m");
  });

  it("never shows a circle tighter than the venue's floor", () => {
    renderSection({
      ...metric,
      visibilityRadius: 100,
      venueCeiling: {
        state: "area",
        venueName: "The Bat Cave",
        radiusMeters: 2000,
      },
    });
    expect(
      screen.getByTestId("visibility-public-preview").textContent,
    ).toContain("2 km");
    expect(
      screen
        .getByTestId("visibility-radius-slider")
        .getAttribute("aria-valuetext"),
    ).toContain("2 km");
  });

  it("still says hidden for the fully-hidden sentinel", () => {
    renderSection({ ...metric, visibilityRadius: null });
    expect(
      screen.getByTestId("visibility-public-preview").textContent,
    ).toContain("area label only");
  });
});

describe("the reveal choice at someone else's withheld venue", () => {
  const GATE_COPY =
    "Ticket holders get it only after the place confirms your event, and no earlier than a day before it starts.";

  it("says the venue gates the reveal when the viewer doesn't manage a venue that hides its address", () => {
    renderSection({
      venueCeiling: { state: "hidden", venueName: "The Bat Cave" },
    });
    const note = screen.getByTestId("address-reveal-venue-gate");
    expect(note.textContent).toContain("This place hides its address.");
    expect(note.textContent).toContain(GATE_COPY);
    // Wired to the select, so a screen reader hears it at the control.
    expect(screen.getByTestId("address-reveal-preset")).toHaveAttribute(
      "aria-describedby",
      "address-reveal-venue-gate",
    );
  });

  it("says it for a venue that publishes only an approximate area too", () => {
    renderSection({
      venueCeiling: {
        state: "area",
        venueName: "The Bat Cave",
        radiusMeters: 1000,
      },
    });
    expect(
      screen.getByTestId("address-reveal-venue-gate"),
    ).toBeInTheDocument();
  });

  it("stays quiet for someone who manages the venue", () => {
    renderSection({
      viewerManagesVenue: true,
      venueCeiling: { state: "hidden", venueName: "The Bat Cave" },
    });
    expect(screen.queryByTestId("address-reveal-venue-gate")).toBeNull();
    expect(screen.getByTestId("address-reveal-preset")).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("stays quiet with no venue, or a venue that publishes its address", () => {
    renderSection();
    expect(screen.queryByTestId("address-reveal-venue-gate")).toBeNull();
  });

  it("claims nothing while the venue's setting is still unknown", () => {
    renderSection({ venueCeiling: { state: "checking" } });
    expect(screen.queryByTestId("address-reveal-venue-gate")).toBeNull();
  });

  it("gives way to the NEVER consequence, which is stricter than the venue", () => {
    renderSection({
      addressRevealPreset: "NEVER",
      venueCeiling: { state: "hidden", venueName: "The Bat Cave" },
    });
    expect(screen.queryByTestId("address-reveal-venue-gate")).toBeNull();
    expect(
      screen.getByTestId("address-reveal-never-consequence"),
    ).toBeInTheDocument();
  });
});
