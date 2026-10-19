import { describe, expect, it } from "vitest";

import { SkipLink } from "../NavigationShell.styles";
import { renderWithProvider } from "../../../../test/utils";

const renderSkipLink = () => {
  const { container } = renderWithProvider(
    <SkipLink asChild>
      <a href="#main-content">Skip to content</a>
    </SkipLink>,
  );
  return container.querySelector("a") as HTMLAnchorElement;
};

const styleRulesFor = (el: HTMLElement): CSSStyleRule[] => {
  const classes = Array.from(el.classList);
  return Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules ?? []))
    .filter((rule): rule is CSSStyleRule => rule instanceof window.CSSStyleRule)
    .filter((rule) =>
      classes.some((cls) => rule.selectorText.includes(`.${cls}`)),
    );
};

describe("NavigationShell SkipLink", () => {
  // Regression: the link is visually hidden at top-left over the mobile
  // hamburger. Hidden must also mean not hit-testable AND out of the hit
  // area, or it swallows the hamburger's taps (including the synthesized
  // taps touch screen readers activate with).
  it("is not hit-testable and parked off-screen while hidden", () => {
    const el = renderSkipLink();
    const computed = window.getComputedStyle(el);

    expect(computed.opacity).toBe("0");
    expect(computed.getPropertyValue("pointer-events")).toBe("none");
    // The hiding mechanism must be `top`, NOT a translate: Tamagui emits
    // transforms as inline style, which a :focus-visible class rule can
    // never override — a transform-based reveal silently never runs.
    expect(computed.top).toBe("-100px");
    expect(computed.transform === "" || computed.transform === "none").toBe(
      true,
    );
  });

  it("becomes visible and clickable on keyboard focus", () => {
    const el = renderSkipLink();
    const focusVisibleRules = styleRulesFor(el).filter((rule) =>
      rule.selectorText.includes(":focus-visible"),
    );

    expect(
      focusVisibleRules.some(
        (rule) => rule.style.getPropertyValue("opacity") === "1",
      ),
    ).toBe(true);
    expect(
      focusVisibleRules.some(
        (rule) => rule.style.getPropertyValue("pointer-events") === "auto",
      ),
    ).toBe(true);
    // The reveal must restore an on-screen `top` (see hiding-mechanism
    // note). The value is a space token (a CSS var in jsdom), so assert
    // the property is set and is not the parked -100px.
    expect(
      focusVisibleRules.some((rule) => {
        const top = rule.style.getPropertyValue("top");
        return top !== "" && top !== "-100px";
      }),
    ).toBe(true);
  });
});
