import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Amenity chips (`.chipRowOnPageSurface`) are outline chips: no fill, so they
 * sit on whatever surface the page root paints. Their ink must come from that
 * same root, never from a fixed colour.
 *
 * The two roots paint different things when the owner set no theme:
 *   - the standard template's `.placeRoot` paints Stub cream with Stub ink;
 *   - the freeform `.content` paints NOTHING (`transparent`) and inherits the
 *     app's ink, so in Ember the chips sit on navy.
 *
 * A dark hard-coded fallback (`#211C16`) read on cream and vanished on navy.
 * `currentColor` follows whichever ink the root resolved. jsdom cannot compute
 * a custom-property cascade, so this reads the rules from the stylesheets.
 */

const ROOT = path.resolve(__dirname, "..");

function ruleBody(file: string, selector: string): string {
  const css = readFileSync(path.join(ROOT, file), "utf8");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`${selector} not found in ${file}`);
  return match[2]!;
}

describe("amenity chip ink on a freeform page with no owner theme", () => {
  it("the freeform root paints no surface of its own and inherits the app's ink", () => {
    const content = ruleBody("entity-page-shell.module.css", ".content");
    expect(content).toMatch(/background-color:\s*var\(--th-color-bg,\s*transparent\)/);
    expect(content).toMatch(/color:\s*var\(--th-color-text,\s*inherit\)/);
  });

  it("so the chips fall back to the container's ink, not a fixed colour", () => {
    const chips = ruleBody(
      "blocks/block-primitives.module.css",
      ".chipRowOnPageSurface",
    );
    expect(chips).toMatch(/--color:\s*var\(--th-color-text,\s*currentColor\)/);
    expect(chips).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("the standard root still pairs its cream with Stub ink, which currentColor picks up", () => {
    const root = ruleBody("place-entity.module.css", ".placeRoot");
    expect(root).toMatch(/background:\s*var\(--th-color-bg,\s*#F6F0E4\)/);
    expect(root).toMatch(/color:\s*var\(--th-color-text,\s*#211C16\)/);
  });
});
