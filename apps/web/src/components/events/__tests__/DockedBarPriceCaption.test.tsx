import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DockedBarPriceCaption } from "../DockedBarPriceCaption";

/**
 * jsdom has no layout, so geometry is stubbed — but the stub REACTS to the
 * caption's state, the way a real browser does: the price column is
 * `shownHeight` tall while the caption is laid out, and 55px (label +
 * figure) once it has stepped aside. That is what makes a measurement taken
 * in the wrong state visible to these tests.
 */
const BAR_TOP = 600;
const BAR_HEIGHT = 84;
const HIDDEN_COLUMN_HEIGHT = 55;
let shownHeight = 71.4;

const rect = (top: number, height: number) =>
  ({
    top,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

const captionEl = () => screen.getByTestId("event-sticky-bar-breakdown");
const steppedAside = () => captionEl().getAttribute("data-overflow") === "true";

/** A ResizeObserver that keeps its callback so a test can fire it. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

// vitest.setup.ts defines a no-op ResizeObserver as writable but NOT
// configurable, so it is swapped by assignment and put back after.
const realResizeObserver = window.ResizeObserver;

beforeEach(() => {
  shownHeight = 71.4;
  FakeResizeObserver.instances = [];
  window.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("event-sticky-bar")) {
        return rect(BAR_TOP, BAR_HEIGHT);
      }
      if (this.classList.contains("event-sticky-bar__price")) {
        const aside =
          this.querySelector('[data-overflow="true"]') !== null;
        const height = aside ? HIDDEN_COLUMN_HEIGHT : shownHeight;
        return rect(BAR_TOP + (BAR_HEIGHT - height) / 2, height);
      }
      return rect(0, 0);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  window.ResizeObserver = realResizeObserver;
  document.head.querySelectorAll("style[data-test-css]").forEach((n) => n.remove());
});

const renderInBar = () =>
  render(
    <div className="event-sticky-bar">
      <div className="event-sticky-bar__price">
        <DockedBarPriceCaption text="incl. $2.45 fees + $4.13 tax" />
      </div>
    </div>,
  );

describe("DockedBarPriceCaption", () => {
  it("shows the caption when the price column fits the 84px bar", () => {
    renderInBar();
    expect(captionEl()).toHaveTextContent("incl. $2.45 fees + $4.13 tax");
    expect(steppedAside()).toBe(false);
  });

  it("boundary: a three-line caption (column 83.4px) stays VISIBLE", () => {
    shownHeight = 83.4;
    renderInBar();
    expect(steppedAside()).toBe(false);
  });

  it("steps aside when the shown column would spill the bar, and STAYS aside (no oscillation)", () => {
    shownHeight = 118.2; // Spanish at 320px: five wrapped lines
    renderInBar();
    expect(steppedAside()).toBe(true);
    const [observer] = FakeResizeObserver.instances;
    observer!.fire();
    expect(steppedAside()).toBe(true);
    observer!.fire();
    expect(steppedAside()).toBe(true);
  });

  it("comes back when the column fits again (rotation, wider window)", () => {
    shownHeight = 118.2;
    renderInBar();
    expect(steppedAside()).toBe(true);
    shownHeight = 71.4;
    FakeResizeObserver.instances[0]!.fire();
    expect(steppedAside()).toBe(false);
  });

  it("observes the bar AND the price column, and disconnects on unmount", () => {
    const { unmount } = renderInBar();
    const [observer] = FakeResizeObserver.instances;
    const observed = observer!.observe.mock.calls.map(
      ([el]) => (el as HTMLElement).className,
    );
    expect(observed).toEqual(["event-sticky-bar", "event-sticky-bar__price"]);
    unmount();
    expect(observer!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("stepped aside = visually hidden by the shipped .sr-only rule, still in the accessibility tree", () => {
    // Lift the REAL backstop rule out of the stylesheet, so this fails if the
    // selector is dropped from it.
    const css = readFileSync(
      resolve(__dirname, "../event-content.css"),
      "utf8",
    );
    const rule = css.match(
      /\.event-sticky-bar__caption\[data-overflow="true"\],\s*\.sr-only\s*\{[^}]*\}/,
    );
    expect(rule).not.toBeNull();
    const style = document.createElement("style");
    style.setAttribute("data-test-css", "");
    style.textContent = rule![0];
    document.head.appendChild(style);

    shownHeight = 118.2;
    renderInBar();
    const caption = captionEl();
    expect(steppedAside()).toBe(true);

    const computed = getComputedStyle(caption);
    expect(computed.position).toBe("absolute");
    expect(computed.width).toBe("1px");
    expect(computed.height).toBe("1px");
    expect(computed.overflow).toBe("hidden");
    // ...but NOT removed from the accessibility tree.
    expect(computed.display).not.toBe("none");
    expect(computed.visibility).not.toBe("hidden");
    expect(caption).not.toHaveAttribute("hidden");
    expect(caption).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByText("incl. $2.45 fees + $4.13 tax"),
    ).toBe(caption);
  });
});
