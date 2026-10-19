/**
 * The alerts panel holds the navbar shown while it is open. The page can
 * still scroll under it (iOS Safari only half honours `body { overflow:
 * hidden }`), and a scroll-down recorded during the hold used to slide the
 * bar away the moment the panel closed, taking the bell that focus had just
 * been restored to with it.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHoldNavbarShown } from "@/components/navigation/navbar-hold-store";

vi.mock("@/hooks/useIsDarkTheme", () => ({ useIsDarkTheme: () => false }));

const { ScrollAwareNavbar } = await import("../ScrollAwareNavbar");

function Holder({ active }: { active: boolean }) {
  useHoldNavbarShown(active);
  return <span>bar</span>;
}

function tree(held: boolean) {
  return (
    <ScrollAwareNavbar>
      <Holder active={held} />
    </ScrollAwareNavbar>
  );
}

function scrollTo(y: number) {
  act(() => {
    window.scrollY = y;
    window.dispatchEvent(new Event("scroll"));
  });
}

const isHidden = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>(".swiss-navbar-wrapper")!
    .style.transform.startsWith("translateY(-");

const originalWidth = window.innerWidth;
let rafSpy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  // Mobile: only there does the bar hide on scroll.
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 375,
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    writable: true,
    value: 0,
  });
  rafSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb) => {
      cb(0);
      return 0;
    });
});

afterEach(() => {
  // Only this spy: `restoreAllMocks` would also wipe the setup file's
  // `matchMedia` mock implementation.
  rafSpy?.mockRestore();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalWidth,
  });
});

describe("ScrollAwareNavbar hold", () => {
  it("hides on a mobile scroll-down when nothing holds it", () => {
    const { container, unmount } = render(tree(false));
    scrollTo(200);
    expect(isHidden(container)).toBe(true);
    unmount();
  });

  it("a scroll-down DURING a hold does not hide the bar once the hold is released", () => {
    const { container, rerender, unmount } = render(tree(true));
    scrollTo(200);
    expect(isHidden(container)).toBe(false);

    rerender(tree(false));
    expect(isHidden(container)).toBe(false);

    // The next scroll-down after the release hides it as usual.
    scrollTo(400);
    expect(isHidden(container)).toBe(true);
    unmount();
  });
});
