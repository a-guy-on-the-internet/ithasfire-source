import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The audio block's edit rail puts Download and Delete 4px apart and gives
 * each a 9px invisible tap overlay on coarse pointers. Overlapping overlays let
 * Delete (later in DOM, painted on top) take taps landing on the visible
 * Download toggle — measured at 320px with touch emulation on 2026-10-14.
 * jsdom cannot hit-test, so this pins the arithmetic in the stylesheet:
 * the gap between the two buttons must be at least both overlays together.
 */

const css = readFileSync(
  path.resolve(__dirname, "../prose-editor.css"),
  "utf8",
);

const nodeViewSource = readFileSync(
  path.resolve(__dirname, "../extensions/AudioBlockNodeView.tsx"),
  "utf8",
);

/** px of a Tamagui space token, read from the design system's scale. */
function spaceTokenPx(token: string): number {
  const scale = readFileSync(
    path.resolve(
      __dirname,
      "../../../../../../../../../../../packages/ui/src/ui/tamagui/tokens/space.ts",
    ),
    "utf8",
  );
  const m = new RegExp(`\\${token}:\\s*(\\d+)`).exec(scale);
  if (!m) throw new Error(`space token ${token} not found`);
  return Number(m[1]);
}

/** Rules inside `@media (pointer: coarse) { ... }` blocks, concatenated. */
function coarseRules(): string {
  const out: string[] = [];
  const re = /@media \(pointer: coarse\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(start, i - 1));
  }
  return out.join("\n");
}

describe("audio rail coarse-pointer tap overlays", () => {
  it("never overlap between the two rail buttons", () => {
    const rules = coarseRules();
    const overlay = /\.th-audio-rail-btn::after\s*\{[^}]*inset:\s*-(\d+)px/.exec(
      rules,
    );
    const sibling =
      /\.th-audio-rail-btn \+ \.th-audio-rail-btn\s*\{[^}]*margin-left:\s*(\d+)px/.exec(
        rules,
      );
    expect(overlay).not.toBeNull();
    expect(sibling).not.toBeNull();

    const overlayPx = Number(overlay![1]);
    // RailActions' gap lives in AudioBlockNodeView.tsx as the `$1` space
    // token. Both are read from source, so a changed gap or a rescaled token
    // is re-checked here instead of trusting a copied 4.
    const railActions = /const RailActions = styled\(XStack, \{[^}]*gap:\s*"(\$\d+)"/.exec(
      nodeViewSource,
    );
    expect(railActions).not.toBeNull();
    const railGapPx = spaceTokenPx(railActions![1]);
    const spacing = railGapPx + Number(sibling![1]);
    expect(spacing).toBeGreaterThanOrEqual(overlayPx * 2);
  });

  it("leaves the desktop rail spacing alone", () => {
    const selector = /\.th-audio-rail-btn \+ \.th-audio-rail-btn/g;
    const everywhere = css.match(selector)?.length ?? 0;
    const coarseOnly = coarseRules().match(selector)?.length ?? 0;
    expect(everywhere).toBe(coarseOnly);
  });
});
