import "@testing-library/jest-dom/vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { configure } from "@testing-library/react";
import { Platform } from "react-native";
import { expect } from "vitest";

import "./act-environment";

expect.extend(matchers);

// CI runs this suite concurrently with six others on a single-capacity
// runner; testing-library's 1s `waitFor` default then flakes interaction
// tests (NavigationShell auto-open, EventCardPriceReveal — runs 590/598/600)
// that pass everywhere else. Local runs keep the strict default so a slow
// test stays a real signal.
if (process.env.CI) {
  configure({ asyncUtilTimeout: 10_000 });
}

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

if (Platform.OS !== "web") {
  Object.defineProperty(Platform, "OS", {
    value: "web",
    configurable: true,
  });
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}

if (
  typeof window !== "undefined" &&
  typeof window.IntersectionObserver === "undefined"
) {
  class MockIntersectionObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}

    observe(_target: Element): void {}

    unobserve(): void {}

    disconnect(): void {}

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  window.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
}
