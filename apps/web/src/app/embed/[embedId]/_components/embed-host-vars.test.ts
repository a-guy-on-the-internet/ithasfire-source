import { afterEach, describe, expect, it } from "vitest";
import { stubTheme } from "@th/ui/colors";

import {
  HOST_VAR_NAMES,
  brandLadder,
  contrast,
  deriveHostVars,
  linkOn,
  mutedOn,
  readableOn,
} from "./embed-host-vars";
import { getResolvedEmbedStripeColors } from "./embed-theme";

const none = { brandColor: null, bg: null, fontColor: null, accentColor: null };
const hex = (h: string) => (h.startsWith("#") ? h : `#${h}`);

/** A 4096-colour sweep (every 17th value per channel) for property checks. */
const SWEEP: string[] = [];
for (let r = 0; r < 256; r += 17)
  for (let g = 0; g < 256; g += 17)
    for (let b = 0; b < 256; b += 17)
      SWEEP.push(
        `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`,
      );

describe("the admin's dark-site setup: fontColor only, transparent bg", () => {
  const vars = deriveHostVars({ ...none, fontColor: "FFFFFF" });

  it("gives text-bearing wells a ground that pairs with the text", () => {
    const text = vars["--hf-text"]!;
    expect(vars["--hf-ground"]).toBeDefined();
    expect(contrast(text, vars["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, vars["--hf-ground-muted"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("muted text and placeholders clear AA on both grounds", () => {
    const muted = vars["--hf-text-muted"]!;
    expect(muted.toUpperCase()).not.toBe("#FFFFFF");
    expect(contrast(muted, vars["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, vars["--hf-ground-muted"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("does NOT invent a host bg (the widget stays transparent)", () => {
    expect(vars).not.toHaveProperty("--hf-bg");
  });

  describe("Stripe gets the same pair", () => {
    afterEach(() => {
      document.documentElement.removeAttribute("style");
      document.body.removeAttribute("style");
    });

    it("text vs inputBackground ≥ 4.5 with the platform's cream still on body", () => {
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
      // What the root layout paints: the Stub canvas.
      document.body.style.setProperty("--background", stubTheme.background);
      document.body.style.setProperty("--color", stubTheme.color);
      const c = getResolvedEmbedStripeColors();
      expect(c.text).toBe("#FFFFFF");
      expect(c.inputBackground).toBe(vars["--hf-ground"]);
      expect(contrast(c.text, c.inputBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.textMuted, c.inputBackground)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it.each(["FFFFFF", "E8E8E8", "333333", "000000", "F5D90A", "1D4ED8"])(
    "any text colour (%s) gets an AA ground and muted rung",
    (fontColor) => {
      const v = deriveHostVars({ ...none, fontColor });
      expect(contrast(hex(fontColor), v["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v["--hf-text-muted"]!, v["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v["--hf-text-muted"]!, v["--hf-ground-muted"]!)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("bg keeps its existing contract", () => {
  it("the host bg IS the ground; --hf-bg / --hf-bg-muted are unchanged", () => {
    const v = deriveHostVars({ ...none, bg: "111111", fontColor: "FFFFFF" });
    expect(v["--hf-bg"]).toBe("#111111");
    expect(v["--hf-bg-muted"]).toBe("rgba(17, 17, 17, 0.65)");
    expect(v["--hf-ground"]).toBe("#111111");
    expect(contrast(v["--hf-text-muted"]!, "#111111")).toBeGreaterThanOrEqual(4.5);
  });

  it("no knobs, no vars — the light default is untouched", () => {
    expect(deriveHostVars(none)).toEqual({});
  });
});

describe("brandLadder — one label for every rung", () => {
  it("mid-grey 8A8A8A: the label clears AA at rest AND on hover", () => {
    const l = brandLadder("8A8A8A");
    expect(contrast(l.label, l.rest)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(l.label, l.hover)).toBeGreaterThanOrEqual(4.5);
    // Hover must still be a visible change.
    expect(l.hover.toLowerCase()).not.toBe(l.rest.toLowerCase());
  });

  it.each(["000000", "FFFFFF", "767676", "7F7F7F", "F5D90A", "1D4ED8", "E2481D", "FF5721"])(
    "edge colour %s",
    (b) => {
      const l = brandLadder(b);
      expect(contrast(l.label, l.rest)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(l.label, l.hover)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("holds across a 4096-colour sweep", () => {
    const failures = SWEEP.filter((c) => {
      const l = brandLadder(c);
      return Math.min(contrast(l.label, l.rest), contrast(l.label, l.hover)) < 4.5;
    });
    expect(failures).toEqual([]);
  });

  it("dark brands keep the darkening hover under a white label", () => {
    const l = brandLadder("1D4ED8");
    expect(l.label).toBe("#FFFFFF");
    expect(contrast(l.label, l.hover)).toBeGreaterThan(contrast(l.label, l.rest));
  });
});

describe("readableOn / mutedOn", () => {
  it("readableOn clears AA for every colour in the sweep", () => {
    expect(SWEEP.filter((c) => contrast(readableOn(c), c) < 4.5)).toEqual([]);
  });

  it("prefers the platform ink over pure black when both clear", () => {
    expect(readableOn("#F5D90A")).toBe(stubTheme.color);
  });

  it("mutedOn sits between text and ground and still clears AA", () => {
    const m = mutedOn("#FFFFFF", "#2D2923");
    expect(m).not.toBe("#FFFFFF");
    expect(contrast(m, "#2D2923")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the text colour's grounds hold AA at every host text colour", () => {
  // The reviewer's case: a fixed 6% tint put 767676 at ~4.24:1 on its own
  // fields ground (white companion 4.54:1), and the muted ground at ~3.88:1.
  it("fontColor=767676: text clears AA on both grounds", () => {
    const v = deriveHostVars({ ...none, fontColor: "767676" });
    expect(contrast("#767676", v["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#767676", v["--hf-ground-muted"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("text AND muted text clear AA on both grounds across a 4096-colour sweep", () => {
    const failures: string[] = [];
    for (const c of SWEEP) {
      const v = deriveHostVars({ ...none, fontColor: c.slice(1) });
      const pairs: Array<[string, string, string]> = [
        ["text/ground", c, v["--hf-ground"]!],
        ["text/muted-ground", c, v["--hf-ground-muted"]!],
        ["muted/ground", v["--hf-text-muted"]!, v["--hf-ground"]!],
        ["muted/muted-ground", v["--hf-text-muted"]!, v["--hf-ground-muted"]!],
        // Muted body text on the host page itself (transparent body).
        ["muted/page", v["--hf-text-muted"]!, readableOn(c)],
      ];
      for (const [name, fg, bg] of pairs) {
        if (contrast(fg, bg) < 4.5) failures.push(`${c} ${name} ${contrast(fg, bg).toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("still tints the well when there is room (a well still reads as a well)", () => {
    const v = deriveHostVars({ ...none, fontColor: "FDFAF3" });
    expect(v["--hf-ground"]).not.toBe(readableOn("#FDFAF3"));
    expect(v["--hf-ground-muted"]).not.toBe(v["--hf-ground"]);
  });
});

describe("--hf-link: link / accent text for a host text colour", () => {
  it("Dark (paper text) gets a light link that clears AA on the grounds AND a #111 page", () => {
    const v = deriveHostVars({ ...none, fontColor: stubTheme.onStructure.slice(1) });
    const link = v["--hf-link"]!;
    expect(contrast(link, v["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(link, v["--hf-ground-muted"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(link, "#111111")).toBeGreaterThanOrEqual(4.5);
    // The platform link rung it replaces reads at about 2:1 there.
    expect(contrast(stubTheme.accentText, "#111111")).toBeLessThan(3);
    // Still the brand hue, not just the text colour.
    expect(link.toLowerCase()).not.toBe(stubTheme.onStructure.toLowerCase());
  });

  it("starts from the host brand when one is set", () => {
    const withBrand = deriveHostVars({ ...none, fontColor: "FFFFFF", brandColor: "1D4ED8" });
    const [r, , b] = [1, 3, 5].map((i) => parseInt(withBrand["--hf-link"]!.slice(i, i + 2), 16));
    expect(b!).toBeGreaterThan(r!); // blue-ish, from the brand
  });

  it("follows the live platform accent (an active preset), not only Stub", () => {
    const o = { ...none, fontColor: "FDFAF3" };
    const stub = deriveHostVars(o)["--hf-link"]!;
    const preset = deriveHostVars(o, { accent: "#2563EB" })["--hf-link"]!;
    expect(preset).not.toBe(stub);
    const [r, , b] = [1, 3, 5].map((i) => parseInt(preset.slice(i, i + 2), 16));
    expect(b!).toBeGreaterThan(r!); // the preset's blue, made readable
    expect(contrast(preset, deriveHostVars(o)["--hf-ground"]!)).toBeGreaterThanOrEqual(4.5);
    // Unusable values fall back to Stub (also the SSR path).
    expect(deriveHostVars(o, { accent: "rgba(1,2,3,1)" })["--hf-link"]).toBe(stub);
    expect(deriveHostVars(o, { accent: "" })["--hf-link"]).toBe(stub);
    // A host brand still outranks the platform accent.
    expect(deriveHostVars({ ...o, brandColor: "F5D90A" }, { accent: "#2563EB" })["--hf-link"]).toBe(
      deriveHostVars({ ...o, brandColor: "F5D90A" })["--hf-link"],
    );
  });

  it("is only derived with a host text colour", () => {
    expect(deriveHostVars({ ...none, brandColor: "1D4ED8" })).not.toHaveProperty("--hf-link");
    expect(deriveHostVars({ ...none, bg: "111111" })).not.toHaveProperty("--hf-link");
  });

  it("clears AA on every ground across the sweep, with and without a brand", () => {
    const failures: string[] = [];
    for (const c of SWEEP) {
      for (const brandColor of [null, "1D4ED8", "F5D90A"]) {
        const v = deriveHostVars({ ...none, fontColor: c.slice(1), brandColor });
        for (const g of [v["--hf-ground"]!, v["--hf-ground-muted"]!, readableOn(c)]) {
          if (contrast(v["--hf-link"]!, g) < 4.5) failures.push(`${c} ${brandColor} on ${g}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("linkOn returns the hue untouched when it already reads", () => {
    expect(linkOn("#1D4ED8", "#211C16", ["#FFFFFF"])).toBe("#1d4ed8");
  });

  it("is cleaned up with the rest", () => {
    expect(HOST_VAR_NAMES).toContain("--hf-link");
  });
});
