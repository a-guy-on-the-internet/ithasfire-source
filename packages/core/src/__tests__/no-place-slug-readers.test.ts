import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * STEP-4 GATE — `Place.slug` has no readers left.
 *
 * A place used to carry TWO slugs:
 *
 *   · `Place.slug`      — multi-segment DIRECTORY key
 *                         (`us/tn/backstage-nashville--lknkdsbay9`).
 *   · `EntityPage.slug` — flat `{name}-{id8}`, minted by `buildPageSlug`.
 *
 * Only the second is addressable. `/places/[slug]` and `/p/[slug]` are SINGLE
 * non-catch-all segments and they resolve the entity page, so a `Place.slug`
 * failed those routes twice over — wrong path shape AND wrong column. It was
 * modelled on `generateEventSlug`, which works only because
 * `/events/[...slug]` IS catch-all; places never got that route, so the column
 * has been structurally unresolvable since the day it was introduced. Two
 * separate bug classes came out of the pair.
 *
 * Nothing mints it (`upsertPlace` — see the "mints NO Place.slug" test there)
 * and nothing reads it. This test is what makes DROPPING THE COLUMN safe: if
 * it is green, the only thing standing between the schema and a clean
 * `DROP COLUMN` is the migration itself.
 *
 * Scope is `packages/core/src` + `packages/adapters/src` — everything that can
 * reach Postgres through the repos. The `PlacesRepo` port carries no slug
 * surface at all, so a new reader would have to add one back, and that is
 * exactly what this catches.
 *
 * If this fails: do NOT add the name to the allowlist. Repoint the reader at
 * `placeId` or at the place's `EntityPage.slug`.
 */

const PACKAGES_DIR = path.resolve(__dirname, "..", "..", "..");

const SCANNED_ROOTS = [
  path.join(PACKAGES_DIR, "core", "src"),
  path.join(PACKAGES_DIR, "adapters", "src"),
];

/**
 * Every identifier that only ever existed to serve `Place.slug`.
 *
 * `getBySlug` / `resolveBySlug` / `recordSlugHistory` are deliberately matched
 * only when they hang off a `places` receiver: the EVENTS and ENTITY-PAGES
 * repos have their own, legitimate, still-live methods by those exact names,
 * and `Event.slug` really does route (`/events/[...slug]` is catch-all).
 */
const BANNED: { label: string; pattern: RegExp }[] = [
  {
    label: "generatePlaceSlug (the removed Place.slug generator)",
    pattern: /\bgeneratePlaceSlug\b/,
  },
  {
    label: "PlaceSlugContext / AssignPlaceSlugInput / PlaceSlugResolution / RecordPlaceSlugHistoryInput",
    pattern:
      /\b(PlaceSlugContext|AssignPlaceSlugInput|PlaceSlugResolution|RecordPlaceSlugHistoryInput)\b/,
  },
  {
    label: "PlaceSlugHistory (the deprecated history table)",
    pattern: /\b(placeSlugHistory|PlaceSlugHistory)\b/,
  },
  {
    label: "places.getBySlug / .resolveBySlug / .assignSlug / .getSlugContext / .recordSlugHistory",
    pattern:
      /\bplaces\s*\.\s*(getBySlug|resolveBySlug|assignSlug|getSlugContext|recordSlugHistory)\b/,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments before matching. Every one of these names is *mentioned* in
 * prose across the codebase ("deliberately NOT `Place.slug`"), and that prose
 * is the institutional memory that stops the column being reinvented — the
 * gate must not punish it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FILES = SCANNED_ROOTS.flatMap(walk).filter(
  (f) => !/\.test\.tsx?$/.test(f) && !/__tests__/.test(f),
);

describe("Place.slug has no readers left (step-4 gate)", () => {
  it("scans a non-trivial number of files — a silently empty scan is not a gate", () => {
    expect(FILES.length).toBeGreaterThan(400);
  });

  it.each(BANNED)(
    "no source file in core/adapters references $label",
    ({ pattern }) => {
      const offenders: string[] = [];
      for (const file of FILES) {
        const code = stripComments(readFileSync(file, "utf8"));
        for (const [i, line] of code.split("\n").entries()) {
          if (pattern.test(line)) {
            offenders.push(
              `${path.relative(PACKAGES_DIR, file)}:${i + 1}: ${line.trim()}`,
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it("no Prisma query on the `place` model selects or writes `slug`", () => {
    const PRISMA_OP =
      "findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy";
    const ANY_MODEL_QUERY = new RegExp(
      `\\.\\s*(\\w+)\\s*\\.\\s*(?:${PRISMA_OP})\\s*\\(`,
    );
    const BARE_SLUG = /(^|[^a-zA-Z.])slug\s*[:,]/;

    const offenders: string[] = [];
    for (const file of FILES) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      for (const [i, line] of lines.entries()) {
        const opened = ANY_MODEL_QUERY.exec(line);
        if (opened?.[1] !== "place") continue;
        // The argument object of a Prisma call sits comfortably inside 40
        // lines. Stop early at the NEXT model's query, so an `entityPage`
        // read nested in a place-hydration loop is not misread as a
        // `Place.slug` select — `EntityPage.slug` is the slug that survives.
        for (let j = i; j < Math.min(i + 40, lines.length); j++) {
          const candidate = lines[j]!;
          if (j > i) {
            const nested = ANY_MODEL_QUERY.exec(candidate);
            if (nested && nested[1] !== "place") break;
          }
          if (BARE_SLUG.test(candidate)) {
            offenders.push(
              `${path.relative(PACKAGES_DIR, file)}:${j + 1}: ${candidate.trim()}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the PlacesRepo port declares no slug surface", () => {
    const port = readFileSync(
      path.join(PACKAGES_DIR, "ports", "src", "repos", "places.ts"),
      "utf8",
    );
    const body = stripComments(port);
    for (const method of [
      "getBySlug",
      "resolveBySlug",
      "assignSlug",
      "getSlugContext",
      "recordSlugHistory",
    ]) {
      expect(body).not.toContain(`${method}(`);
    }
  });

  it("PlaceRecord carries no `slug` field", () => {
    const types = readFileSync(
      path.join(PACKAGES_DIR, "types", "src", "repos", "places.ts"),
      "utf8",
    );
    const record = stripComments(types).match(
      /export interface PlaceRecord \{[\s\S]*?\n\}/,
    );
    expect(record).not.toBeNull();
    expect(record![0]).not.toMatch(/(^|[^a-zA-Z])slug\s*[?:]/m);
  });
});
