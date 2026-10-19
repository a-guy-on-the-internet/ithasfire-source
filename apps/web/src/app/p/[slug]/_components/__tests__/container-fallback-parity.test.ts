import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Parity guard for the entity page's container-query fallbacks.
 *
 * Every `@container entity-page (max-width: N)` layout block is followed by a
 * twin for browsers without container queries:
 *
 *   @supports not (container-type: inline-size) {
 *     @media (max-width: M) { …the same declarations… }
 *   }
 *
 * The twin must carry the IDENTICAL body, and M must be the viewport width the
 * container width N came from: N is a content width, the viewport less the
 * AppShell gutters (2 x 16px up to a 640px viewport, 2 x 32px above;
 * shell-metrics.ts). So M - N is 32 when M <= 640 and 64 above. Editing one
 * twin and not the other fails here.
 *
 * `ENTITY_PAGE_CSS_ROOT` points the test at a copy of the `_components` tree
 * (used to check that the test fails on a drifted copy); it defaults to the
 * real one.
 */

const ROOT =
  process.env.ENTITY_PAGE_CSS_ROOT ?? path.resolve(__dirname, "..");

/** File → number of converted `@container entity-page` blocks it must hold. */
const FILES: Record<string, number> = {
  "place-entity.module.css": 4,
  "entity-page-shell.module.css": 1,
  "blocks/block-primitives.module.css": 2,
  "blocks/review-tier.module.css": 1,
  "blocks/TrackRecordBlock.module.css": 1,
  "blocks/VenueStatsBlock.module.css": 1,
  "blocks/AudienceStatsBlock.module.css": 1,
};

type Block = { prelude: string; body: string };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Split CSS into its top-level `prelude { body }` blocks by brace matching.
 * Quoted strings are skipped so a brace inside one cannot unbalance it.
 */
function topLevelBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = -1;
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1);
      if (end === -1) throw new Error("unterminated string");
      i = end;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        prelude = css.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) throw new Error("unbalanced }");
      if (depth === 0) {
        blocks.push({ prelude, body: css.slice(bodyStart, i) });
        preludeStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      // A top-level statement such as `@import …;`.
      preludeStart = i + 1;
    }
  }
  if (depth !== 0) throw new Error("unbalanced {");
  return blocks;
}

function normalise(body: string): string {
  return body
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,>+~])\s*/g, "$1")
    .trim();
}

const CONTAINER = /^@container entity-page \(max-width: (\d+)px\)$/;
const SUPPORTS_NOT = "@supports not (container-type: inline-size)";
const MEDIA = /^@media \(max-width: (\d+)px\)$/;

describe("entity page: container-query fallbacks match their container rules", () => {
  it.each(Object.entries(FILES))("%s", (file, expected) => {
    const css = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
    const blocks = topLevelBlocks(css);
    let found = 0;
    blocks.forEach((block, index) => {
      const container = CONTAINER.exec(block.prelude);
      if (!container) return;
      found++;
      const n = Number(container[1]);
      const where = `${file}: @container (max-width: ${n}px)`;

      const twin = blocks[index + 1];
      expect(twin?.prelude, `${where} has no fallback right after it`).toBe(
        SUPPORTS_NOT,
      );
      const inner = topLevelBlocks(twin!.body);
      expect(inner.length, `${where}: fallback holds one @media block`).toBe(1);
      const media = MEDIA.exec(inner[0]!.prelude);
      expect(media, `${where}: fallback is a max-width @media`).not.toBeNull();
      const m = Number(media![1]);

      expect(m - n, `${where}: viewport ${m}px vs content ${n}px`).toBe(
        m <= 640 ? 32 : 64,
      );
      expect(normalise(inner[0]!.body), `${where}: twin bodies differ`).toBe(
        normalise(block.body),
      );
    });
    expect(found, `${file}: converted block count`).toBe(expected);
  });
});
