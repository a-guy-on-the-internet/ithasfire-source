import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeroBackdrop } from "../HeroBackdrop";

/**
 * HeroBackdrop clips the fixed blurred poster to the bottom of the element
 * marked `data-hero-backdrop-window`, measured against its own root box, so
 * the footer stops showing the blur. Reduced motion skips the parallax only.
 */

const ROOT_BOTTOM = 800;

function rect(bottom: number): DOMRect {
  return { bottom } as DOMRect;
}

function stubMatchMedia(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({ matches: reduced }),
  });
}

function mountWindowMarker(bottom: number) {
  const win = document.createElement("div");
  win.setAttribute("data-hero-backdrop-window", "");
  win.getBoundingClientRect = () => rect(bottom);
  document.body.appendChild(win);
  return win;
}

function renderBackdrop() {
  const utils = render(<HeroBackdrop imageUrl="/poster.jpg" />);
  const root = utils.container.querySelector<HTMLElement>(".hero-backdrop")!;
  return { root, layer: root.firstElementChild as HTMLElement };
}

describe("HeroBackdrop", () => {
  let originalGetRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    stubMatchMedia(false);
    originalGetRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("hero-backdrop")
        ? rect(ROOT_BOTTOM)
        : originalGetRect.call(this);
    };
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetRect;
    document
      .querySelectorAll("[data-hero-backdrop-window]")
      .forEach((n) => n.remove());
  });

  it("does not cut when the window ends below the backdrop", () => {
    mountWindowMarker(ROOT_BOTTOM + 300);
    const { root } = renderBackdrop();
    expect(root.style.clipPath).toBe("inset(0 0 0px 0)");
  });

  it("cuts the backdrop at the window's bottom edge", () => {
    mountWindowMarker(ROOT_BOTTOM - 250);
    const { root } = renderBackdrop();
    expect(root.style.clipPath).toBe("inset(0 0 250px 0)");
  });

  it("leaves the backdrop unclipped without a window marker", () => {
    const { root } = renderBackdrop();
    expect(root.style.clipPath).toBe("");
  });

  it("under reduced motion writes no parallax but still clips", () => {
    stubMatchMedia(true);
    mountWindowMarker(ROOT_BOTTOM - 100);
    const { root, layer } = renderBackdrop();
    expect(layer.style.transform).toBe("translate3d(0, 0, 0)");
    expect(root.style.clipPath).toBe("inset(0 0 100px 0)");
  });
});
