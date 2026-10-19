import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  closeSpotlight,
  isSpotlightOpen,
  openSpotlight,
  useSpotlightKeyboard,
} from "../spotlight-store";

/**
 * The Spotlight chord is registered by `useSpotlightKeyboard`, which
 * GlobalOverlays mounts. It went dead once already because its only caller
 * was deleted, so these pin both halves: the chord toggles the store, and
 * however many times the hook mounts (StrictMode double-invoke, two shells)
 * there is ONE listener. Two would toggle open-then-closed on a single press
 * and look exactly like "⌘K does nothing".
 *
 * The chord is per platform: ⌘K on Apple platforms, where Ctrl+K is the OS
 * "kill to end of line" in text fields and must be left alone; Ctrl+K
 * everywhere else.
 */

function press(init: KeyboardEventInit, target: EventTarget = document) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

const strict = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

function stubPlatform(platform: string, uaDataPlatform?: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: uaDataPlatform === undefined ? undefined : { platform: uaDataPlatform },
  });
}

// Every mount goes through here so afterEach can unmount it even when an
// assertion threw first — a leaked mount would keep the listener alive into
// the next test.
const mounted: Array<{ unmount: () => void }> = [];
function mountKeyboard(options?: { wrapper?: typeof strict }) {
  const result = renderHook(() => useSpotlightKeyboard(), options);
  const handle = {
    unmount: () => {
      const i = mounted.indexOf(handle);
      if (i === -1) return;
      mounted.splice(i, 1);
      result.unmount();
    },
  };
  mounted.push(handle);
  return handle;
}

describe("useSpotlightKeyboard", () => {
  beforeEach(() => {
    closeSpotlight();
    stubPlatform("MacIntel");
  });
  afterEach(() => {
    while (mounted.length > 0) mounted[mounted.length - 1]!.unmount();
    closeSpotlight();
    vi.restoreAllMocks();
    // `userAgentData` was defined as an own property by stubPlatform; the
    // prototype getter (if the environment has one) shows through again.
    delete (navigator as { userAgentData?: unknown }).userAgentData;
  });

  describe("on a Mac", () => {
    it("⌘K opens, ⌘K again closes", () => {
      mountKeyboard();
      const event = press({ key: "k", metaKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(isSpotlightOpen()).toBe(true);
      press({ key: "k", metaKey: true });
      expect(isSpotlightOpen()).toBe(false);
    });

    it("Caps Lock's 'K' still counts", () => {
      mountKeyboard();
      press({ key: "K", metaKey: true });
      expect(isSpotlightOpen()).toBe(true);
    });

    it("Ctrl+K is the OS kill-line: no toggle, no preventDefault", () => {
      mountKeyboard();
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      const event = press({ key: "k", ctrlKey: true }, input);
      expect(isSpotlightOpen()).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      input.remove();
    });

    it("⌃⌘K (both modifiers) is not the chord", () => {
      mountKeyboard();
      const event = press({ key: "k", metaKey: true, ctrlKey: true });
      expect(isSpotlightOpen()).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("works from inside a text input — it is a modifier chord", () => {
      mountKeyboard();
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      press({ key: "k", metaKey: true }, input);
      expect(isSpotlightOpen()).toBe(true);
      input.remove();
    });

    it("userAgentData.platform wins over navigator.platform", () => {
      stubPlatform("Win32", "macOS");
      mountKeyboard();
      press({ key: "k", ctrlKey: true });
      expect(isSpotlightOpen()).toBe(false);
      press({ key: "k", metaKey: true });
      expect(isSpotlightOpen()).toBe(true);
    });

    it("iPad counts as Apple", () => {
      stubPlatform("iPad");
      mountKeyboard();
      press({ key: "k", ctrlKey: true });
      expect(isSpotlightOpen()).toBe(false);
      press({ key: "k", metaKey: true });
      expect(isSpotlightOpen()).toBe(true);
    });
  });

  describe("on Windows / Linux", () => {
    beforeEach(() => stubPlatform("Win32"));

    it("Ctrl+K opens and is marked handled", () => {
      mountKeyboard();
      const event = press({ key: "k", ctrlKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(isSpotlightOpen()).toBe(true);
    });

    it("Meta+K (the Windows key) is not the chord", () => {
      mountKeyboard();
      press({ key: "k", metaKey: true });
      expect(isSpotlightOpen()).toBe(false);
    });
  });

  it("plain k, and an auto-repeat ⌘K, do nothing", () => {
    mountKeyboard();
    press({ key: "k" });
    press({ key: "k", metaKey: true, repeat: true });
    expect(isSpotlightOpen()).toBe(false);
  });

  it("leaves a ⌘K that a deeper handler already claimed", () => {
    mountKeyboard();
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener("keydown", (e) => e.preventDefault());
    press({ key: "k", metaKey: true }, el);
    expect(isSpotlightOpen()).toBe(false);
    el.remove();
  });

  it("Escape closes an open spotlight and marks the event handled", () => {
    mountKeyboard();
    openSpotlight();
    const event = press({ key: "Escape" });
    expect(isSpotlightOpen()).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Escape while closed is not swallowed (the alerts panel needs it)", () => {
    mountKeyboard();
    const event = press({ key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
  });

  it("registers exactly one listener under StrictMode and multiple mounts", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const keydownAdds = () =>
      add.mock.calls.filter(([type]) => type === "keydown").length;
    const keydownRemoves = () =>
      remove.mock.calls.filter(([type]) => type === "keydown").length;

    const a = mountKeyboard({ wrapper: strict });
    const b = mountKeyboard({ wrapper: strict });

    // One live listener: a single press toggles once, not open-then-closed.
    press({ key: "k", metaKey: true });
    expect(isSpotlightOpen()).toBe(true);
    expect(keydownAdds() - keydownRemoves()).toBe(1);

    // Unmounting one of two mounts keeps the shortcut alive...
    a.unmount();
    press({ key: "k", metaKey: true });
    expect(isSpotlightOpen()).toBe(false);

    // ...and the last unmount removes it.
    b.unmount();
    expect(keydownAdds() - keydownRemoves()).toBe(0);
    press({ key: "k", metaKey: true });
    expect(isSpotlightOpen()).toBe(false);
  });
});
