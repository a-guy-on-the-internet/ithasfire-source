import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildStripeAppearance,
  isDarkBackground,
  useThemeColors,
} from "../stripe-appearance-theme";

/**
 * On the dark (Ember) theme Stripe's field labels and its "Secure, fast
 * checkout with Link" line rendered as near-invisible dark text: the theme
 * colours were read after the first paint, and the base theme stayed light.
 */
const EMBER = { fg: "#F3EDE2", bg: "#16120E" };
const STUB = { fg: "#211C16", bg: "#FDFAF3" };

const setBodyVars = ({ fg, bg }: { fg: string; bg: string }) => {
  document.body.style.setProperty("--color", fg);
  document.body.style.setProperty("--surface", bg);
};

afterEach(() => {
  cleanup();
  document.body.style.removeProperty("--color");
  document.body.style.removeProperty("--surface");
});

describe("buildStripeAppearance — light vs dark", () => {
  it("regression: Ember (dark) → Stripe's night base, light text, secondary text light too", () => {
    const a = buildStripeAppearance({ ...EMBER, placeholder: "#71717a" });
    expect(a.theme).toBe("night");
    expect(a.variables.colorText).toBe(EMBER.fg);
    expect(a.variables.colorBackground).toBe(EMBER.bg);
    expect(a.variables.colorTextSecondary).toBe(`${EMBER.fg}B3`);
    expect(a.variables.colorTextPlaceholder).toBe(`${EMBER.fg}80`);
    expect(a.rules[".Label"].color).toBe(`${EMBER.fg}CC`);
  });

  it("Stub (light) → Stripe's light base, ink text", () => {
    const a = buildStripeAppearance({ ...STUB, placeholder: "#71717a" });
    expect(a.theme).toBe("stripe");
    expect(a.variables.colorText).toBe(STUB.fg);
    expect(a.variables.colorTextPlaceholder).toBe("#71717a");
  });

  it("a non-hex colour is passed through opaque, never made invalid", () => {
    const a = buildStripeAppearance({
      fg: "rgb(243, 237, 226)",
      bg: "rgb(22, 18, 14)",
      placeholder: "#71717a",
    });
    expect(a.theme).toBe("night");
    expect(a.variables.colorTextSecondary).toBe("rgb(243, 237, 226)");
  });

  it("isDarkBackground", () => {
    expect(isDarkBackground(EMBER.bg)).toBe(true);
    expect(isDarkBackground(STUB.bg)).toBe(false);
    expect(isDarkBackground("#000")).toBe(true);
    expect(isDarkBackground("rgba(253, 250, 243, 1)")).toBe(false);
  });
});

describe("useThemeColors — follows the theme", () => {
  it("regression: reads the theme on the FIRST render (no Stub fallback frozen into Stripe's options)", () => {
    setBodyVars(EMBER);
    // Every render's value, in order: the FIRST is what the card freezes
    // into Stripe's options. Reading `result.current` would see the value
    // after the mount effect had already corrected a wrong first render.
    const renders: Array<{ fg: string; bg: string }> = [];
    renderHook(() => {
      const colors = useThemeColors();
      renders.push(colors);
      return colors;
    });
    expect(renders[0]).toMatchObject({ fg: EMBER.fg, bg: EMBER.bg });
  });

  it("regression: a light → dark switch (the injector rewriting <body>'s vars) reaches the hook", async () => {
    setBodyVars(STUB);
    const { result } = renderHook(() => useThemeColors());
    expect(buildStripeAppearance(result.current).theme).toBe("stripe");

    await act(async () => setBodyVars(EMBER));
    await waitFor(() => expect(result.current.bg).toBe(EMBER.bg));
    expect(buildStripeAppearance(result.current).theme).toBe("night");
  });
});
