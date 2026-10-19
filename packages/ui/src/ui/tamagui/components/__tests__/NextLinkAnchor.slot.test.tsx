import { render } from "@testing-library/react";
import { createRequire } from "node:module";
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Button } from "../forms/Button";
import { BUTTON_SLOT_ATTRIBUTE } from "../forms/button-slot";
import { NextLinkAnchor } from "../navigation/NextLinkAnchor";
import { renderWithProvider } from "../../../../../test/utils";

// next/link as a plain forwardRef <a>, so the test exercises NextLinkAnchor's
// next/link branch (domSafeProps + the slot marker), not the Tamagui Anchor
// fallback. `data-mock-link` proves the mock is the one rendering.
//
// NextLinkAnchor loads next/link with a lazy CommonJS `require`, which
// `vi.mock` does not intercept (measured: the real next/link rendered). Seed
// Node's require cache instead, and restore it afterwards.
const MockLink = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: unknown }
>(function MockLink({ prefetch: _prefetch, ...props }, ref) {
  lastLinkPropKeys = Object.keys(props);
  return <a ref={ref} data-mock-link="" {...props} />;
});
// What next/link actually received. React warns about an unknown `onPress`
// only ONCE per session, so a console.error assertion alone is order-
// dependent; this is not.
let lastLinkPropKeys: string[] = [];

const nodeRequire = createRequire(import.meta.url);
const nextLinkPath = nodeRequire.resolve("next/link");
let previousEntry: NodeJS.Module | undefined;

beforeAll(() => {
  previousEntry = nodeRequire.cache[nextLinkPath];
  nodeRequire.cache[nextLinkPath] = {
    id: nextLinkPath,
    filename: nextLinkPath,
    loaded: true,
    exports: { __esModule: true, default: MockLink },
  } as unknown as NodeJS.Module;
});

afterAll(() => {
  if (previousEntry) nodeRequire.cache[nextLinkPath] = previousEntry;
  else delete nodeRequire.cache[nextLinkPath];
});

describe("NextLinkAnchor inline defaults", () => {
  it("keeps color/display/align-items defaults when not slotted", () => {
    const { container } = render(
      <NextLinkAnchor href="/plain">Plain</NextLinkAnchor>,
    );
    const link = container.querySelector("a")!;
    expect(link.hasAttribute("data-mock-link")).toBe(true);
    expect(link.style.color).toBe("inherit");
    expect(link.style.display).toBe("flex");
    expect(link.style.alignItems).toBe("center");
    expect(link.style.textDecoration).toBe("none");
  });

  it("drops them when <Button asChild> slots it, keeping text-decoration", () => {
    const { container } = render(
      <NextLinkAnchor href="/slotted" {...{ [BUTTON_SLOT_ATTRIBUTE]: "" }}>
        Slotted
      </NextLinkAnchor>,
    );
    const link = container.querySelector("a")!;
    expect(link.hasAttribute("data-mock-link")).toBe(true);
    expect(link.hasAttribute(BUTTON_SLOT_ATTRIBUTE)).toBe(true);
    expect(link.style.color).toBe("");
    expect(link.style.display).toBe("");
    expect(link.style.alignItems).toBe("");
    expect(link.style.textDecoration).toBe("none");
  });

  it("still lets a slotted caller style through", () => {
    const { container } = render(
      <NextLinkAnchor
        href="/slotted"
        {...{ [BUTTON_SLOT_ATTRIBUTE]: "" }}
        style={{ display: "flex", textTransform: "uppercase" }}
      >
        Slotted
      </NextLinkAnchor>,
    );
    const link = container.querySelector("a")!;
    expect(link.style.display).toBe("flex");
    expect(link.style.textTransform).toBe("uppercase");
    expect(link.style.color).toBe("");
  });
});

/**
 * <Button asChild> around a COMPONENT child (NextLinkAnchor → next/link).
 * Tamagui's Slot maps `onPress` → `onClick` only for HTML children; for a
 * component child it forwards `onPress` verbatim, NextLinkAnchor passes every
 * `on*` prop to next/link, and next/link spreads them onto the <a>: React's
 * "Unknown event handler property `onPress`" console.error, which fails the
 * e2e console gate. Press handling for a component child must arrive as its
 * onClick instead.
 */
describe("Button asChild around NextLinkAnchor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const unknownHandlerErrors = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter((call) =>
      call.map(String).join(" ").includes("Unknown event handler"),
    );

  for (const state of ["disabled", "locked"] as const) {
    it(`${state}: blocks the click without leaking onPress`, () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const stateProps = { [state]: true };
      const { container } = renderWithProvider(
        <Button variant="outlined" asChild {...stateProps}>
          <NextLinkAnchor href="/admin/org/volunteers/asks/1">
            Manage
          </NextLinkAnchor>
        </Button>,
      );
      const link = container.querySelector("a")!;
      expect(link.hasAttribute("data-mock-link")).toBe(true);
      expect(link.hasAttribute("onpress")).toBe(false);
      expect(lastLinkPropKeys).not.toContain("onPress");
      expect(lastLinkPropKeys).toContain("onClick");
      expect(link.getAttribute("aria-disabled")).toBe("true");
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(unknownHandlerErrors(consoleError)).toEqual([]);
    });
  }

  it("enabled: a caller onClick (legacyBehavior Link) reaches the <a> as onClick", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const onClick = vi.fn();
    const legacyLinkProps = { onClick } as Record<string, unknown>;
    const { container } = renderWithProvider(
      <Button variant="outlined" asChild {...legacyLinkProps}>
        <NextLinkAnchor href="/somewhere">Somewhere</NextLinkAnchor>
      </Button>,
    );
    const link = container.querySelector("a")!;
    expect(link.hasAttribute("onpress")).toBe(false);
    expect(lastLinkPropKeys).not.toContain("onPress");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(unknownHandlerErrors(consoleError)).toEqual([]);
  });

  it("enabled: the child's own onClick still runs alongside the caller's", () => {
    const callerPress = vi.fn();
    const childClick = vi.fn();
    const { container } = renderWithProvider(
      <Button variant="outlined" asChild onPress={callerPress}>
        <NextLinkAnchor href="/somewhere" onClick={childClick}>
          Somewhere
        </NextLinkAnchor>
      </Button>,
    );
    container
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(childClick).toHaveBeenCalledTimes(1);
    expect(callerPress).toHaveBeenCalledTimes(1);
    expect(lastLinkPropKeys).not.toContain("onPress");
  });

  // onPressIn / onPressOut must reach next/link under DOM names, never
  // verbatim (next/link would spread them onto the <a>). Tamagui's asChild
  // path maps them to onMouseDown / onMouseUp (+ touch) before Slot; this pins
  // that, so a Tamagui upgrade that stops doing it fails here.
  it("enabled: onPressIn / onPressOut reach next/link as onMouseDown / onMouseUp", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const pressIn = vi.fn();
    const pressOut = vi.fn();
    const childMouseDown = vi.fn();
    const { container } = renderWithProvider(
      <Button
        variant="outlined"
        asChild
        onPressIn={pressIn}
        onPressOut={pressOut}
      >
        <NextLinkAnchor href="/somewhere" onMouseDown={childMouseDown}>
          Somewhere
        </NextLinkAnchor>
      </Button>,
    );
    expect(lastLinkPropKeys).not.toContain("onPressIn");
    expect(lastLinkPropKeys).not.toContain("onPressOut");
    expect(lastLinkPropKeys).toContain("onMouseDown");
    expect(lastLinkPropKeys).toContain("onMouseUp");
    const link = container.querySelector("a")!;
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(childMouseDown).toHaveBeenCalledTimes(1);
    expect(pressIn).toHaveBeenCalledTimes(1);
    expect(pressOut).toHaveBeenCalledTimes(1);
    expect(unknownHandlerErrors(consoleError)).toEqual([]);
  });

  const pressInOutRuns = (link: Element) => {
    for (const type of ["mousedown", "mouseup"]) {
      link.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    for (const type of ["touchstart", "touchend"]) {
      link.dispatchEvent(new Event(type, { bubbles: true }));
    }
  };

  for (const state of ["disabled", "locked"] as const) {
    it(`${state}: onPressIn / onPressOut are dropped, not leaked or run`, () => {
      const pressIn = vi.fn();
      const pressOut = vi.fn();
      const { container } = renderWithProvider(
        <Button
          variant="outlined"
          asChild
          {...{ [state]: true }}
          onPressIn={pressIn}
          onPressOut={pressOut}
        >
          <NextLinkAnchor href="/somewhere">Somewhere</NextLinkAnchor>
        </Button>,
      );
      expect(lastLinkPropKeys).not.toContain("onPressIn");
      expect(lastLinkPropKeys).not.toContain("onPressOut");
      pressInOutRuns(container.querySelector("a")!);
      expect(pressIn).not.toHaveBeenCalled();
      expect(pressOut).not.toHaveBeenCalled();
    });
  }

  it("disabled bare <a>: onPressIn / onPressOut are dropped, not leaked or run", () => {
    const pressIn = vi.fn();
    const pressOut = vi.fn();
    const { container } = renderWithProvider(
      <Button
        variant="outlined"
        asChild
        disabled
        onPressIn={pressIn}
        onPressOut={pressOut}
      >
        <a href="/somewhere">Somewhere</a>
      </Button>,
    );
    const link = container.querySelector("a")!;
    expect(link.hasAttribute("onpressin")).toBe(false);
    pressInOutRuns(link);
    expect(pressIn).not.toHaveBeenCalled();
    expect(pressOut).not.toHaveBeenCalled();
  });

  // Middle-click fires auxclick, not click, and opens the href in a new tab
  // unless auxclick is cancelled.
  for (const state of ["disabled", "locked"] as const) {
    it(`${state}: cancels a middle-click (auxclick) and keeps the href`, () => {
      const { container } = renderWithProvider(
        <Button variant="outlined" asChild {...{ [state]: true }}>
          <NextLinkAnchor href="/admin/org/volunteers/asks/1">
            Manage
          </NextLinkAnchor>
        </Button>,
      );
      expect(lastLinkPropKeys).toContain("onAuxClick");
      const link = container.querySelector("a")!;
      expect(link.getAttribute("href")).toBe("/admin/org/volunteers/asks/1");
      const event = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  it("enabled: leaves middle-click alone", () => {
    const { container } = renderWithProvider(
      <Button variant="outlined" asChild>
        <NextLinkAnchor href="/plain">Plain</NextLinkAnchor>
      </Button>,
    );
    expect(lastLinkPropKeys).not.toContain("onAuxClick");
    const event = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("enabled with no handlers: renders no stray handler props", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { container } = renderWithProvider(
      <Button variant="outlined" asChild>
        <NextLinkAnchor href="/plain">Plain</NextLinkAnchor>
      </Button>,
    );
    expect(container.querySelector("a")!.hasAttribute("onpress")).toBe(false);
    expect(lastLinkPropKeys).not.toContain("onPress");
    expect(unknownHandlerErrors(consoleError)).toEqual([]);
  });
});
