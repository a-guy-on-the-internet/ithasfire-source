import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => "https://host.example",
}));

import { useEmbedBridge } from "./useEmbedBridge";

const realParent = Object.getOwnPropertyDescriptor(window, "parent");
const realRO = (window as unknown as { ResizeObserver: unknown })
  .ResizeObserver;
let postMessage: ReturnType<typeof vi.fn>;
let fireResize: () => void;

function setBodyHeight(h: number) {
  Object.defineProperty(document.body, "scrollHeight", {
    configurable: true,
    value: h,
  });
}

function resizeHeights(): number[] {
  return postMessage.mock.calls
    .map((c) => c[0] as { type: string; height?: number })
    .filter((m) => m.type === "hf:resize")
    .map((m) => m.height as number);
}

describe("useEmbedBridge hf:resize height ceiling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessage = vi.fn();
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage },
    });
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(cb: () => void) {
        fireResize = cb;
      }
      observe() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      realRO;
    if (realParent) Object.defineProperty(window, "parent", realParent);
    delete (document.body as unknown as { scrollHeight?: number }).scrollHeight;
  });

  function post(height: number) {
    setBodyHeight(height);
    renderHook(() => useEmbedBridge("e1", "list" as never));
    fireResize();
    vi.advanceTimersByTime(150);
    return resizeHeights();
  }

  it("posts a 2700px body unclipped (the old 2000 cap cut it off)", () => {
    expect(post(2700)).toEqual([2700]);
  });

  it("posts a 36,000px body unclipped (50 stacked poster cards)", () => {
    expect(post(36000)).toEqual([36000]);
  });

  it("clips at the 50000 ceiling", () => {
    expect(post(80000)).toEqual([50000]);
  });
});
