/**
 * BookingIntentControl — the one rule the cascade suite cannot reach: the
 * group must NEVER lose its tab stop. When the current value is not offered
 * (a hydrated intent the venue has since switched off, or a provisional guess
 * at a rent-only venue) the selected radio is disabled, so the first ENABLED
 * radio carries `tabIndex=0` instead.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|tabIndex|type|onKeyDown)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  return {
    XStack: makeStack("div"),
    styled: (_base: unknown, config?: { tag?: string }) =>
      makeStack(config?.tag === "button" ? "button" : "div"),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
  };
});

const { BookingIntentControl } = await import("../BookingIntentControl");

const LABELS = { PERFORM: "Play here", RENT: "Rent a space", USE: "Use a space" };

describe("BookingIntentControl — roving tab stop", () => {
  it("the selected radio is the tab stop when it is offered", () => {
    render(
      <>
        <span id="lbl">Book this place for</span>
        <BookingIntentControl
          value="RENT"
          offered={["PERFORM", "RENT"]}
          onChange={vi.fn()}
          labels={LABELS}
          labelledBy="lbl"
          idBase="g"
        />
      </>,
    );
    expect(screen.getByRole("radio", { name: "Rent a space" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Play here" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "Use a space" })).toHaveAttribute("tabindex", "-1");
  });

  it("value NOT offered → the first enabled radio is the tab stop, and arrows still work from it", () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="lbl">Book this place for</span>
        <BookingIntentControl
          value="PERFORM"
          offered={["RENT", "USE"]}
          onChange={onChange}
          labels={LABELS}
          labelledBy="lbl"
          idBase="g"
        />
      </>,
    );
    const play = screen.getByRole("radio", { name: "Play here" });
    const rent = screen.getByRole("radio", { name: "Rent a space" });
    const use = screen.getByRole("radio", { name: "Use a space" });
    // The (disabled) current value never takes the stop…
    expect(play).toHaveAttribute("aria-disabled", "true");
    expect(play).toHaveAttribute("tabindex", "-1");
    // …the first ENABLED radio does — exactly one stop in the group.
    expect(rent).toHaveAttribute("tabindex", "0");
    expect(use).toHaveAttribute("tabindex", "-1");

    rent.focus();
    fireEvent.keyDown(rent, { key: "ArrowRight" });
    // With nothing offered selected, forward lands on the first enabled radio.
    expect(onChange).toHaveBeenCalledWith("RENT");
  });
});
