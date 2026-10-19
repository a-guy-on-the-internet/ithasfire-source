import { afterEach, describe, expect, it, vi } from "vitest";

import { detectDeviceLabel } from "../device-label";

type NavigatorStub = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string };
};

const stubNavigator = (nav: NavigatorStub | undefined) => {
  vi.stubGlobal("navigator", nav);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectDeviceLabel", () => {
  it("returns null when there is no navigator (SSR)", () => {
    stubNavigator(undefined);
    expect(detectDeviceLabel()).toBeNull();
  });

  it("prefers the Client Hints platform over the legacy UA/platform pair", () => {
    stubNavigator({
      // A Windows UA + the opaque legacy "Win32" — the hint must win, and it
      // must not be the thing that produced the old debug-looking names.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      platform: "Win32",
      userAgentData: { platform: "Windows" },
    });
    expect(detectDeviceLabel()).toBe("Windows");
  });

  it("squashes both ChromeOS spellings from Client Hints", () => {
    stubNavigator({ userAgentData: { platform: "Chrome OS" } });
    expect(detectDeviceLabel()).toBe("ChromeOS");

    stubNavigator({ userAgentData: { platform: "Chromium OS" } });
    expect(detectDeviceLabel()).toBe("ChromeOS");
  });

  it("maps the iOS hint to a device name, never the bare OS name", () => {
    // Unreachable in practice — the hint API is Chromium-only and every iOS
    // browser is WebKit — but "iOS" is in the spec'd value set, and passing it
    // through verbatim produced `Tom’s iOS` where every other branch produces a
    // device.
    stubNavigator({ userAgentData: { platform: "iOS" } });
    expect(detectDeviceLabel()).toBe("iPhone");
  });

  it.each([
    ["Unknown", "Chromium's own can't-tell sentinel"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["FreeBSD", "a value outside the spec'd set"],
    ["Tom's Laptop", "a spoofed hint (this is client-controlled input)"],
  ])(
    "falls through to the UA probe when the hint is %j (%s)",
    (hintedPlatform) => {
      stubNavigator({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 0,
        userAgentData: { platform: hintedPlatform },
      });
      expect(detectDeviceLabel()).toBe("macOS");
    },
  );

  it.each([
    [
      "macOS",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15",
      "MacIntel",
      0,
    ],
    [
      "iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Mobile/15E148 Safari/604.1",
      "iPhone",
      5,
    ],
    [
      "Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/126",
      "Win32",
      0,
    ],
    [
      "Android",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      "Linux armv8l",
      5,
    ],
    [
      "ChromeOS",
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Linux x86_64",
      0,
    ],
    [
      "Linux",
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
      "Linux x86_64",
      0,
    ],
  ])(
    "maps a legacy UA to %s",
    (expected, userAgent, platform, maxTouchPoints) => {
      stubNavigator({ userAgent, platform, maxTouchPoints });
      expect(detectDeviceLabel()).toBe(expected);
    },
  );

  it("distinguishes iPadOS from macOS via multi-touch (iPadOS reports a desktop UA)", () => {
    const iPadOsDesktopUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15";

    stubNavigator({
      userAgent: iPadOsDesktopUa,
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(detectDeviceLabel()).toBe("iPad");

    // Same UA, no touch → a real Mac.
    stubNavigator({
      userAgent: iPadOsDesktopUa,
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(detectDeviceLabel()).toBe("macOS");
  });

  it("still reports iPad when the UA names it outright", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16 Mobile/15E148 Safari/604.1",
      platform: "iPad",
      maxTouchPoints: 5,
    });
    expect(detectDeviceLabel()).toBe("iPad");
  });

  it("returns null (never a placeholder) when nothing is recognizable", () => {
    stubNavigator({ userAgent: "Mozilla/5.0 (darwin) jsdom/24", platform: "" });
    expect(detectDeviceLabel()).toBeNull();
  });

  it("tolerates a navigator with no usable fields at all", () => {
    stubNavigator({});
    expect(detectDeviceLabel()).toBeNull();
  });

  it("returns null rather than passing an unrecognized hint through verbatim", () => {
    // No UA to fall back on either, so the allowlist miss is the whole result.
    // The old passthrough would have stored `Tom’s Haiku` as a credential name.
    stubNavigator({ userAgentData: { platform: "Haiku" } });
    expect(detectDeviceLabel()).toBeNull();
  });

  it("is not fooled by a Node >= 21 global navigator on the server", () => {
    // The `typeof navigator === "undefined"` guard does NOT fire on modern Node
    // — it defines a global `navigator` with `userAgent: "Node.js/22"`. The
    // result is still null, but because nothing matches, not because of the
    // guard. Pinned so the comment in device-label.ts stays honest.
    stubNavigator({ userAgent: "Node.js/22" });
    expect(detectDeviceLabel()).toBeNull();
  });
});
