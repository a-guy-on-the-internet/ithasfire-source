import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isApplePlatform,
  isCommandPaletteChord,
} from "./command-palette-chord";

function stubPlatform(platform: string, uaDataPlatform?: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value:
      uaDataPlatform === undefined ? undefined : { platform: uaDataPlatform },
  });
}

const chord = (init: Partial<KeyboardEventInit> = {}) => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...init,
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { userAgentData?: unknown }).userAgentData;
});

describe("isCommandPaletteChord", () => {
  it("a keydown with no key (Safari autofill) is not the chord, and does not throw", () => {
    stubPlatform("MacIntel");
    const autofill = { metaKey: true, ctrlKey: false, altKey: false } as never;
    expect(isCommandPaletteChord(autofill)).toBe(false);
  });

  describe("on a Mac", () => {
    it("⌘K is the chord", () => {
      stubPlatform("MacIntel");
      expect(isCommandPaletteChord(chord({ metaKey: true }))).toBe(true);
    });

    it("Ctrl+K is not (OS kill-line)", () => {
      stubPlatform("MacIntel");
      expect(isCommandPaletteChord(chord({ ctrlKey: true }))).toBe(false);
    });

    it("⌃⌘K is not", () => {
      stubPlatform("MacIntel");
      expect(
        isCommandPaletteChord(chord({ metaKey: true, ctrlKey: true })),
      ).toBe(false);
    });
  });

  describe("on Windows", () => {
    it("Ctrl+K is the chord", () => {
      stubPlatform("Win32");
      expect(isCommandPaletteChord(chord({ ctrlKey: true }))).toBe(true);
    });

    it("Win+K (metaKey) is not", () => {
      stubPlatform("Win32");
      expect(isCommandPaletteChord(chord({ metaKey: true }))).toBe(false);
    });
  });

  it("Caps Lock 'K' counts; Alt, other keys and a bare k do not", () => {
    stubPlatform("MacIntel");
    expect(isCommandPaletteChord(chord({ key: "K", metaKey: true }))).toBe(
      true,
    );
    expect(
      isCommandPaletteChord(chord({ metaKey: true, altKey: true })),
    ).toBe(false);
    expect(isCommandPaletteChord(chord({ key: "j", metaKey: true }))).toBe(
      false,
    );
    expect(isCommandPaletteChord(chord())).toBe(false);
  });
});

describe("isApplePlatform", () => {
  it("prefers userAgentData.platform over navigator.platform", () => {
    stubPlatform("Win32", "macOS");
    expect(isApplePlatform()).toBe(true);
    stubPlatform("MacIntel", "Windows");
    expect(isApplePlatform()).toBe(false);
  });

  it("an EMPTY userAgentData.platform falls back to navigator.platform", () => {
    stubPlatform("MacIntel", "");
    expect(isApplePlatform()).toBe(true);
    expect(isCommandPaletteChord(chord({ metaKey: true }))).toBe(true);
    expect(isCommandPaletteChord(chord({ ctrlKey: true }))).toBe(false);
  });

  it("iPhone and iPad count as Apple; Linux does not", () => {
    stubPlatform("iPhone");
    expect(isApplePlatform()).toBe(true);
    stubPlatform("iPad");
    expect(isApplePlatform()).toBe(true);
    stubPlatform("Linux x86_64");
    expect(isApplePlatform()).toBe(false);
  });
});
