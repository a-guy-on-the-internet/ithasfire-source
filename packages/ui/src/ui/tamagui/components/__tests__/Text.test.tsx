import { renderWithProvider } from "../../../../../test/utils";
import { screen } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";

import { Text } from "../typography/Text";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Text", () => {
  it("renders provided children", () => {
    renderWithProvider(<Text>Hello Ithas Fire</Text>);

    expect(screen.getByText("Hello Ithas Fire")).toBeInTheDocument();
  });

  it("applies automation attributes on web", () => {
    renderWithProvider(
      <Text testId="text-automation" qaId="qa-text">
        Automation ready
      </Text>,
    );

    const element = screen.getByTestId("text-automation");
    expect(element).toHaveAttribute("data-qa", "qa-text");
  });

  it("renders subtitle, body, and bodySmall as spans by default", () => {
    renderWithProvider(
      <>
        <Text variant="subtitle" testId="subtitle-text">
          Subtitle text
        </Text>
        <Text variant="body" testId="body-text">
          Body text
        </Text>
        <Text variant="bodySmall" testId="body-small-text">
          Body small text
        </Text>
      </>,
    );

    expect(screen.getByTestId("subtitle-text").tagName).toBe("SPAN");
    expect(screen.getByTestId("body-text").tagName).toBe("SPAN");
    expect(screen.getByTestId("body-small-text").tagName).toBe("SPAN");
    expect(screen.getByTestId("subtitle-text")).toHaveStyle({
      display: "block",
    });
    expect(screen.getByTestId("body-text")).toHaveStyle({ display: "block" });
    expect(screen.getByTestId("body-small-text")).toHaveStyle({
      display: "block",
    });
  });

  it("allows callers to opt into paragraph semantics", () => {
    renderWithProvider(
      <Text variant="body" tag="p" testId="paragraph-text">
        Paragraph text
      </Text>,
    );

    expect(screen.getByTestId("paragraph-text").tagName).toBe("P");
  });

  it("avoids nested paragraph warnings for composed body text", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    renderWithProvider(
      <Text variant="body">
        Outer copy <Text variant="body">inner copy</Text>
      </Text>,
    );

    const matchedWarning = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          /<p> cannot be a descendant of <p>|validateDOMNesting/i.test(arg),
      ),
    );

    expect(matchedWarning).toBe(false);
  });

  it("supports tone, emphasis, and weight styling", () => {
    renderWithProvider(
      <Text tone="error" emphasis="subtle" weight="bold">
        Styling hooks
      </Text>,
    );

    const element = screen.getByText("Styling hooks");
    expect(element).toHaveStyle({ fontWeight: "700" });
    expect(element).toHaveStyle({ opacity: "0.65" });
  });

  it("can inherit color from parent when requested", () => {
    renderWithProvider(<Text tone="inherit">Inherited tone</Text>);

    const element = screen.getByText("Inherited tone");
    expect(element).toHaveStyle({ color: "inherit" });
  });

  it("applies v2 heading weights (display black, h1-h3 bold)", () => {
    renderWithProvider(
      <>
        <Text variant="display" testId="display-text">
          Display
        </Text>
        <Text variant="h1" testId="h1-text">
          Heading one
        </Text>
        <Text variant="h3" testId="h3-text">
          Heading three
        </Text>
      </>,
    );

    expect(screen.getByTestId("display-text")).toHaveStyle({
      fontWeight: "900",
    });
    expect(screen.getByTestId("h1-text")).toHaveStyle({ fontWeight: "700" });
    expect(screen.getByTestId("h3-text")).toHaveStyle({ fontWeight: "700" });
  });

  it("renders the kicker variant as a mono uppercase inline span", () => {
    renderWithProvider(
      <Text variant="kicker" testId="kicker-text">
        01 / Lineup
      </Text>,
    );

    const element = screen.getByTestId("kicker-text");
    expect(element.tagName).toBe("SPAN");
    expect(element).toHaveStyle({ fontWeight: "600" });
    expect(element).toHaveStyle({ textTransform: "uppercase" });
    // The kicker rides the MONO family as of 2026-08-26 — IBM Plex Mono is a
    // brand font again, and the tracked-uppercase mono label is the idiom this
    // variant exists to carry. (Tamagui compiles the family token to a
    // `font_mono` class; the real stack sits behind var(--f-family), which
    // jsdom cannot resolve.)
    expect(element.classList.contains("font_mono")).toBe(true);
  });

  it("renders the overline variant on the same mono idiom, tracked tighter", () => {
    // overline and kicker are the same idiom at two tracking widths — 2px for
    // the workhorse label, 3px for the editorial eyebrow. If these ever drift
    // onto different families, one of them is wrong.
    renderWithProvider(
      <Text variant="overline" testId="overline-text">
        Doors open
      </Text>,
    );

    const element = screen.getByTestId("overline-text");
    expect(element.classList.contains("font_mono")).toBe(true);
    expect(element).toHaveStyle({ textTransform: "uppercase" });
    expect(element).toHaveStyle({ fontWeight: "600" });
  });

  it("truncates text with ellipsis when requested", () => {
    renderWithProvider(
      <Text truncate testId="truncate-text">
        Ithas Fire condenses overflowing content with a clean ellipsis
        treatment.
      </Text>,
    );

    const element = screen.getByTestId("truncate-text");
    expect(element.style.whiteSpace).toBe("nowrap");
    expect(element.style.overflow).toBe("hidden");
    expect(element.style.textOverflow).toBe("ellipsis");
  });
});
