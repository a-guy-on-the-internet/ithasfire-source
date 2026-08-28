import { expect, test } from "@playwright/test";

import { BUTTON_VARIANT_STYLES } from "../../../packages/ui/src/ui/tamagui/components/forms/button-variants";
import { getStubThemeSnapshot } from "../../../packages/ui/src/ui/tamagui/tokens/colors";

// ─────────────────────────────────────────────────────────────────────────────
// The RESTING label colour, read from a real browser.
//
// Every other guard on this behaviour is colour-blind, which is how the bug
// class survived:
//   - button-label-inheritance.test.ts  → scans source text
//   - Button.theme.test.tsx             → asserts constants + textContent
//   - contrast-pairs.test.ts            → token math on BUTTON_VARIANT_STYLES
//   - the Playwright role/text queries  → ignore colour entirely
// All four stay green if every label renders transparent.
//
// They are green because the atom's ladder is correct ON PAPER. What none of
// them can see is whether the label actually PAINTS it: Tamagui feeds
// ButtonText through `ButtonContext`, and the atom's fix (`textProps.color =
// "inherit"`, web-only) deliberately opts out of that channel to ride the CSS
// cascade from the frame instead. Whether that lands is a runtime property of
// the browser, not of the constants — so only a real computed colour can
// answer it. jsdom can't: it does not resolve Tamagui's injected custom
// properties, so this cannot live in Vitest.
//
// Expectations are DERIVED (atom variant ladder × Stub token snapshot), not
// hand-copied — a hardcoded table would drift from the tokens it mirrors.
//
// Guest-only: /sign-up redirects once authenticated. Registered in
// playwright.config.ts's chromium `testIgnore`.
// ─────────────────────────────────────────────────────────────────────────────

const stub = getStubThemeSnapshot();

/** `"$onBrandSecondary"` → the Stub hex it resolves to. */
const token = (ref: string): string => {
  const key = ref.replace(/^\$/, "") as keyof typeof stub;
  const value = stub[key];
  if (!value) throw new Error(`No Stub token for "${ref}"`);
  return value;
};

/** `#B93312` → `rgb(185, 51, 18)`, the shape getComputedStyle returns. */
const hexToRgb = (hex: string): string => {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

type Probe = {
  frameColor: string;
  frameBg: string;
  labelColor: string;
  labelText: string;
};

/**
 * Read the colour off the element that actually holds the text node — NOT the
 * button frame. The frame was never in doubt; the label was.
 */
const probeButton = async (
  page: import("@playwright/test").Page,
  name: RegExp,
): Promise<Probe> => {
  const button = page.getByRole("button", { name }).first();
  await expect(button).toBeVisible();
  return button.evaluate((btn) => {
    const frame = getComputedStyle(btn);
    const labelEl = Array.from(btn.querySelectorAll("*")).find((el) =>
      Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim(),
      ),
    );
    if (!labelEl) throw new Error("No label element inside button");
    return {
      frameColor: frame.color,
      frameBg: frame.backgroundColor,
      labelColor: getComputedStyle(labelEl).color,
      labelText: (labelEl.textContent ?? "").trim(),
    };
  });
};

const TRANSPARENT = "rgba(0, 0, 0, 0)";

test.describe("Button resting label colour (Stub, the shipped default)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/sign-up");
    // Warm the route: a partial dev-server compile can yield a mid-hydration
    // paint and a bogus colour read.
    await page.waitForLoadState("networkidle");
  });

  test("primary CTA paints $onBrandSecondary on $brandSecondaryHover", async ({
    page,
  }) => {
    const { labelColor, frameColor, frameBg } = await probeButton(
      page,
      /create your account/i,
    );

    const expected = hexToRgb(token(BUTTON_VARIANT_STYLES.primary.color));

    // The headline. A literal read of Tamagui's getSplitStyles predicts
    // `animatableDefaults.color` ("rgba(0,0,0,0)") at rest, because `color` is
    // not a valid style key on a View frame. It does not happen — but nothing
    // proved that until this test, so pin it explicitly rather than by proxy.
    expect(labelColor).not.toBe(TRANSPARENT);
    expect(labelColor).toBe(expected);

    // The label rides the frame's CSS colour; they must not diverge.
    expect(labelColor).toBe(frameColor);

    // Confirms we really are on the RESTING rung, not a hover repaint.
    expect(frameBg).toBe(
      hexToRgb(token(BUTTON_VARIANT_STYLES.primary.backgroundColor)),
    );
  });

  test("outlined CTA paints $accentText on a transparent frame", async ({
    page,
  }) => {
    const { labelColor, frameColor, frameBg } = await probeButton(
      page,
      /^sign in$/i,
    );

    const expected = hexToRgb(token(BUTTON_VARIANT_STYLES.outlined.color));

    expect(labelColor).not.toBe(TRANSPARENT);
    expect(labelColor).toBe(expected);
    expect(labelColor).toBe(frameColor);
    // `outlined` rests transparent — it is the fill that arrives on hover.
    expect(frameBg).toBe(TRANSPARENT);
  });

  test("no button on the page renders an invisible label", async ({ page }) => {
    // Variant-agnostic backstop. The named tests above pin the two variants a
    // guest can reach; this one catches any button here whose label went
    // transparent or stopped tracking its frame, without naming it first.
    const findings = await page.evaluate(() => {
      const out: string[] = [];
      for (const btn of Array.from(document.querySelectorAll("button"))) {
        const labelEl = Array.from(btn.querySelectorAll("*")).find((el) =>
          Array.from(el.childNodes).some(
            (n) =>
              n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim(),
          ),
        );
        if (!labelEl) continue;
        const color = getComputedStyle(labelEl).color;
        const text = (labelEl.textContent ?? "").trim().slice(0, 40);
        if (color === "rgba(0, 0, 0, 0)" || /,\s*0\)$/.test(color)) {
          out.push(`"${text}" → fully transparent label (${color})`);
        }
      }
      return out;
    });

    expect(
      findings,
      `Button labels rendered invisible:\n${findings.join("\n")}`,
    ).toEqual([]);
  });
});
