import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { Switch } from "../forms/Switch";
import { fonts } from "../../index";

/**
 * A locked switch has to be able to say WHY it is locked, and that reason is a
 * DESCRIPTION, not part of the control's name.
 *
 * Before `aria-describedby` existed here, three place toggles folded their
 * refusal copy into `aria-labelledby` — compliant, but it renamed the control
 * ("Accept booking requests Only an owner or admin can change this, switch,
 * off, dimmed"). These pin the passthrough so the workaround cannot come back
 * for want of the prop.
 */
describe("Switch aria-describedby", () => {
  it("forwards the description id to the focusable control", () => {
    renderWithProvider(
      <>
        <span id="lock-reason">Only an owner or admin can change this.</span>
        <Switch
          checked={false}
          onCheckedChange={() => {}}
          disabled
          aria-label="Accept booking requests"
          aria-describedby="lock-reason"
          testId="acceptance"
        />
      </>,
    );

    const control = screen.getByRole("switch", {
      name: "Accept booking requests",
    });
    // The reason describes, and the NAME stays the title alone.
    expect(control).toHaveAttribute("aria-describedby", "lock-reason");
    expect(control).toHaveAccessibleDescription(
      "Only an owner or admin can change this.",
    );
    expect(control).not.toHaveAttribute("aria-labelledby");
  });

  it("leaves the control undescribed when no id is passed", () => {
    renderWithProvider(
      <Switch
        checked
        onCheckedChange={() => {}}
        aria-label="Accept booking requests"
        testId="acceptance"
      />,
    );

    expect(
      screen.getByRole("switch", { name: "Accept booking requests" }),
    ).not.toHaveAttribute("aria-describedby");
  });

  it("carries a description alongside a visible label, not instead of it", () => {
    renderWithProvider(
      <>
        <span id="hint">Visitors see a booking button on your page.</span>
        <Switch
          checked={false}
          onCheckedChange={() => {}}
          label="Accept booking requests"
          aria-describedby="hint"
          testId="acceptance"
        />
      </>,
    );

    const control = screen.getByRole("switch", {
      name: "Accept booking requests",
    });
    expect(control).toHaveAccessibleDescription(
      "Visitors see a booking button on your page.",
    );
  });
});

describe("Switch layout", () => {
  it("lets the label shrink and wrap while the track holds its size", () => {
    // Regression: Tamagui web stacks default to flex-shrink:0 /
    // min-width:auto, so a long label held the row at its single-line width
    // and overflowed narrow parents. jsdom does no layout, so this pins the
    // style contract only — it cannot prove the row actually wraps.
    renderWithProvider(
      <Switch
        checked={false}
        onCheckedChange={() => {}}
        label="Show this venue's full street address to every signed-in visitor"
        testId="wrap"
      />,
    );

    const label = screen.getByText(
      "Show this venue's full street address to every signed-in visitor",
    );
    const row = label.parentElement;
    const track = screen.getByTestId("wrap-track");

    expect(row).not.toBeNull();
    expect(row).toContainElement(track);
    expect(getComputedStyle(label).flexShrink).toBe("1");
    expect(getComputedStyle(label).minWidth).toBe("0px");
    expect(getComputedStyle(row as HTMLElement).flexShrink).toBe("1");
    expect(getComputedStyle(row as HTMLElement).minWidth).toBe("0px");
    expect(getComputedStyle(track).flexShrink).toBe("0");
    expect(getComputedStyle(row as HTMLElement).maxWidth).toBe("100%");
    expect(getComputedStyle(track).width).toBe("48px");
  });

  it("gives the label a real line height and levels its first line with the track", () => {
    // Regression: with no lineHeight, Tamagui's Label fell back to the $true
    // SIZE token (14px) under 16px type — wrapped lines overlapped. The row
    // is top-aligned (like Checkbox/Radio) and the label is pushed down by
    // (trackH − 24) / 2 so line one stays centred on the track.
    renderWithProvider(
      <>
        <Switch
          checked={false}
          onCheckedChange={() => {}}
          label="Default size"
        />
        <Switch
          checked={false}
          onCheckedChange={() => {}}
          label="Small size"
          size="small"
        />
      </>,
    );

    const def = screen.getByText("Default size");
    // jsdom does not resolve Tamagui's CSS variables, so this pins the TOKEN:
    // the $body font's lineHeight step 3 (24px in a browser — measured live),
    // not the size token (--t-size-true, 14px) the Label defaulted to.
    const BODY_LINE_HEIGHT_3 = "var(--f-lineHeight-3)";
    const small = screen.getByText("Small size");

    expect(getComputedStyle(def).lineHeight).toBe(BODY_LINE_HEIGHT_3);
    expect(getComputedStyle(def.parentElement as HTMLElement).alignItems).toBe(
      "flex-start",
    );
    expect(getComputedStyle(def).marginTop).toBe("2px"); // (28 − 24) / 2
    expect(getComputedStyle(small).lineHeight).toBe(BODY_LINE_HEIGHT_3);
    expect(getComputedStyle(small).marginTop).toBe("0px"); // (24 − 24) / 2
  });

  it("offsets the label by the SAME line height the $3 token draws", () => {
    // Switch.tsx does the marginTop maths with a constant; the rendered line
    // box is the token. Derive the expected offset from the token, so moving
    // it fails here instead of the first line sitting off the track's centre.
    const lineHeight = fonts.body.lineHeight[3];
    renderWithProvider(
      <Switch checked={false} onCheckedChange={() => {}} label="Token tie" />,
    );
    expect(getComputedStyle(screen.getByText("Token tie")).marginTop).toBe(
      `${(28 - lineHeight) / 2}px`,
    );
  });
});
