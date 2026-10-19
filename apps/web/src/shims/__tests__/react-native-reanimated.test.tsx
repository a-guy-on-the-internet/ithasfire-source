import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Animated,
  createAnimatedComponent,
  normalizeDomStyle,
} from "../react-native-reanimated";

describe("normalizeDomStyle", () => {
  it("flattens nested style arrays, skipping falsy entries, later wins", () => {
    const result = normalizeDomStyle([
      { position: "fixed", opacity: 0.5 },
      undefined,
      null,
      false,
      [{ opacity: 1 }, { top: 0 }],
    ]);

    expect(result).toEqual({ position: "fixed", opacity: 1, top: 0 });
  });

  it("serializes an RN transform array into a CSS transform string", () => {
    const result = normalizeDomStyle({
      transform: [
        { translateX: 12 },
        { translateY: -4 },
        { perspective: 800 },
        { rotate: 45 },
        { rotateZ: "20deg" },
        { skewX: 10 },
        { scale: 1.2 },
        { scaleY: 2 },
        { matrix: "1, 0, 0, 1, 0, 0" },
      ],
    });

    expect(result).toEqual({
      transform:
        "translateX(12px) translateY(-4px) perspective(800px) rotate(45deg) rotateZ(20deg) skewX(10deg) scale(1.2) scaleY(2) matrix(1, 0, 0, 1, 0, 0)",
    });
  });

  it("serializes transforms found inside a style array", () => {
    const result = normalizeDomStyle([
      { position: "fixed" },
      { transform: [{ translateX: 320 }] },
    ]);

    expect(result).toEqual({
      position: "fixed",
      transform: "translateX(320px)",
    });
  });

  it("returns a plain object unchanged by reference", () => {
    const style = { position: "fixed", transform: "translateX(4px)" };

    expect(normalizeDomStyle(style)).toBe(style);
  });

  it("returns undefined for falsy or non-object input", () => {
    expect(normalizeDomStyle(undefined)).toBeUndefined();
    expect(normalizeDomStyle(null)).toBeUndefined();
    expect(normalizeDomStyle(false)).toBeUndefined();
    expect(normalizeDomStyle("opacity: 1")).toBeUndefined();
  });
});

describe("createAnimatedComponent placeholder branch", () => {
  const Inner = ({ children }: { children?: React.ReactNode }) => (
    <output>{children}</output>
  );
  const arrayStyle = [
    { position: "fixed" } as const,
    { transform: [{ translateX: 320 }] },
  ];

  it("SSR-renders the placeholder <div> with a normalized style", () => {
    const Anim = createAnimatedComponent(Inner);
    const html = renderToString(
      <Anim style={arrayStyle} className="drawer-surface" />,
    );

    expect(html).toContain("translateX(320px)");
    expect(html).toContain("position:fixed");
    expect(html).toContain("drawer-surface");
    // Array indices must never reach the DOM as style keys.
    expect(html).not.toContain("[object Object]");
  });

  // jsdom silently ignores indexed style keys, so this cannot reproduce
  // Chrome's CSSStyleDeclaration crash — the regression pins are the SSR
  // string assertions above and the Animated.View DOM assertion below.
  it("client-renders with an array style without throwing", () => {
    const Anim = createAnimatedComponent(Inner);

    expect(() =>
      render(
        <Anim style={arrayStyle}>
          <span>content</span>
        </Anim>,
      ),
    ).not.toThrow();
  });
});

describe("Animated.View", () => {
  it("normalizes an array style before it lands on the <div>", () => {
    const { container } = render(
      <Animated.View
        style={[{ opacity: 0.5 }, { transform: [{ translateX: 12 }] }]}
      />,
    );

    const div = container.firstElementChild as HTMLDivElement;
    expect(div.style.transform).toBe("translateX(12px)");
    expect(div.style.opacity).toBe("0.5");
  });
});
