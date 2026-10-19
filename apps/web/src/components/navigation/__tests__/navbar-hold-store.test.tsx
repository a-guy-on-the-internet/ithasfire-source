/**
 * The navbar-shown hold is a COUNTER, and these tests exist for exactly that
 * reason: with a boolean, two overlays holding concurrently would lose-update —
 * whichever released first would reveal the navbar from under the one still
 * open. Same class of bug as a nested scroll lock, where the inner unlock
 * restores a page the outer lock still wants locked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  acquireNavbarShownHold,
  isNavbarHeldShown,
  useHoldNavbarShown,
  useNavbarHeldShown,
} from "@/components/navigation/navbar-hold-store";

// Module state is shared across every test in this file, so each one has to
// leave the counter at zero. A leak here would make a LATER test pass for the
// wrong reason.
afterEach(() => {
  expect(isNavbarHeldShown()).toBe(false);
});

describe("navbar hold counter", () => {
  it("is unheld until something takes a hold", () => {
    expect(isNavbarHeldShown()).toBe(false);
    const release = acquireNavbarShownHold();
    expect(isNavbarHeldShown()).toBe(true);
    release();
  });

  it("stays held after ONE of two concurrent holds is released", () => {
    const releaseFirst = acquireNavbarShownHold();
    const releaseSecond = acquireNavbarShownHold();

    releaseFirst();
    expect(isNavbarHeldShown()).toBe(true);

    releaseSecond();
    expect(isNavbarHeldShown()).toBe(false);
  });

  it("does not care which order the two holds are released in", () => {
    const releaseFirst = acquireNavbarShownHold();
    const releaseSecond = acquireNavbarShownHold();

    releaseSecond();
    expect(isNavbarHeldShown()).toBe(true);

    releaseFirst();
    expect(isNavbarHeldShown()).toBe(false);
  });

  it("ignores a repeated release instead of dropping someone else's hold", () => {
    const releaseFirst = acquireNavbarShownHold();
    const releaseSecond = acquireNavbarShownHold();

    releaseFirst();
    releaseFirst();
    releaseFirst();
    expect(isNavbarHeldShown()).toBe(true);

    releaseSecond();
    expect(isNavbarHeldShown()).toBe(false);
  });
});

function Holder({ active }: { active: boolean }) {
  useHoldNavbarShown(active);
  return null;
}

function Reader() {
  const held = useNavbarHeldShown();
  return <span data-testid="held">{held ? "held" : "free"}</span>;
}

const readHeld = () => screen.getByTestId("held").textContent;

describe("useHoldNavbarShown / useNavbarHeldShown", () => {
  it("holds while active, and a subscribed reader re-renders on the flip", () => {
    const view = render(
      <>
        <Reader />
        <Holder active={false} />
      </>,
    );
    expect(readHeld()).toBe("free");

    view.rerender(
      <>
        <Reader />
        <Holder active />
      </>,
    );
    expect(readHeld()).toBe("held");

    view.rerender(
      <>
        <Reader />
        <Holder active={false} />
      </>,
    );
    expect(readHeld()).toBe("free");
  });

  it("releases its hold on unmount, so an overlay torn down while open cannot leak one", () => {
    const view = render(
      <>
        <Reader />
        <Holder active />
      </>,
    );
    expect(readHeld()).toBe("held");

    view.unmount();
    expect(isNavbarHeldShown()).toBe(false);
  });

  it("keeps the hold while a SECOND holder unmounts", () => {
    const view = render(
      <>
        <Reader />
        <Holder active />
        <Holder active />
      </>,
    );
    expect(readHeld()).toBe("held");

    view.rerender(
      <>
        <Reader />
        <Holder active />
      </>,
    );
    expect(readHeld()).toBe("held");

    view.unmount();
    expect(isNavbarHeldShown()).toBe(false);
  });
});
