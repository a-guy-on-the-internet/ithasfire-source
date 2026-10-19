import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { IthasFireProvider } from "@th/ui";

// REAL SearchBar → REAL @th/ui TextInput → REAL Tamagui Input → react-native-web.
//
// Deliberately NO vi.mock("@th/ui") / vi.mock("tamagui") here. The sibling
// AdminTableParts.test.tsx mocks TextInput as a bare <input {...props} />,
// which forwards `data-testid` as if it were a DOM prop — masking the real
// pipeline, where react-native-web's TextInput prop allow-list DROPS spread
// `data-*` attributes. The live browser had 0 nodes for these selectors while
// the mocked tests stayed green; this suite renders the genuine stack so that
// regression class can't recur.
import { SearchBar } from "../AdminTableParts";

function renderWithProvider(ui: ReactNode) {
  return render(<IthasFireProvider>{ui}</IthasFireProvider>);
}

describe("SearchBar (real @th/ui TextInput, unmocked)", () => {
  it("lands the default data-testid on the real DOM <input>", () => {
    renderWithProvider(<SearchBar value="" onChangeText={() => {}} />);

    const node = document.querySelector('[data-testid="at-search-input"]');
    expect(node).toBeInstanceOf(HTMLInputElement);
  });

  it("lands a custom testId on the real DOM <input>", () => {
    renderWithProvider(
      <SearchBar
        value=""
        onChangeText={() => {}}
        testId="attendee-search-input"
      />,
    );

    const node = document.querySelector(
      '[data-testid="attendee-search-input"]',
    );
    expect(node).toBeInstanceOf(HTMLInputElement);
    // The default id must not ALSO render when a custom one is supplied.
    expect(
      document.querySelector('[data-testid="at-search-input"]'),
    ).toBeNull();
  });

  it("keeps the input functional through the testid patch (typing fires onChangeText)", () => {
    const onChangeText = vi.fn();
    renderWithProvider(<SearchBar value="" onChangeText={onChangeText} />);

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="at-search-input"]',
    );
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "sophia" } });
    expect(onChangeText).toHaveBeenCalledWith("sophia");
  });

  it("keeps the 44px tap floor below the 600px mobile breakpoint", () => {
    // Install a matchMedia that reports mobile BEFORE render (vitest.setup's
    // guard only stubs when absent, so per-test overrides are permitted).
    // Only the useIsMobile query matches — everything else (e.g. Tamagui
    // media queries) stays desktop so this test flips ONE branch.
    const original = window.matchMedia;
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width: 599px"),
      media: query,
      onchange: null,
      addListener: (cb: () => void) => listeners.add(cb),
      removeListener: (cb: () => void) => listeners.delete(cb),
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    try {
      renderWithProvider(<SearchBar value="" onChangeText={() => {}} />);

      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="at-search-input"]',
      );
      expect(input).not.toBeNull();
      // useIsMobile syncs from matchMedia in its mount effect, so after
      // render the touch tap floor must be in force.
      expect(input).toHaveStyle({ height: "44px", minHeight: "44px" });
    } finally {
      window.matchMedia = original;
    }
  });

  it("renders the 36px desktop control height (44px is the touch-only tap floor)", () => {
    // vitest.setup.ts stubs matchMedia with matches:false → desktop branch,
    // matching useIsMobile's SSR-safe desktop-first default.
    renderWithProvider(<SearchBar value="" onChangeText={() => {}} />);

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="at-search-input"]',
    );
    expect(input).not.toBeNull();
    // Tamagui Input's default size variant sets height 44 via the $true size
    // token; SearchBar must override BOTH height and minHeight or the field
    // towers over the adjacent 34px sm-scale buttons on pointer viewports.
    expect(input).toHaveStyle({ height: "36px", minHeight: "36px" });
  });
});
