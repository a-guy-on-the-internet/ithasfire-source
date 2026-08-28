import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID,
  composeAssembledWaiverBody,
} from "@th/core/use-cases/waivers";

import { PLATFORM_WAIVER_SEEDS } from "../src/scripts/seed/waivers";
import {
  ALL_CLAUSES,
  PLATFORM_DISCLAIMER,
  type ClauseSeed,
} from "../src/scripts/seed/waiver-clauses";

/**
 * Pins the consolidated platform waiver seeds:
 *  - every assembled template references only clauses that the clause-library
 *    seed actually provides (shared text exists exactly once);
 *  - the double-isDefault footgun stays fixed: exactly one ATTENDEE default
 *    among platform templates, and the volunteer default is a separate,
 *    non-assembled row resolvable by the `kind` discriminator (the migration
 *    enforces this with a partial unique index).
 */

const CLAUSE_LIBRARY: ClauseSeed[] = [...ALL_CLAUSES, PLATFORM_DISCLAIMER];
const clauseBySlug = new Map(CLAUSE_LIBRARY.map((c) => [c.slug, c]));

const KIND_MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/prisma/migrations/20260804120000_waiver_template_kind/migration.sql",
);

describe("platform waiver seeds (assembled)", () => {
  it("references only clauses that exist in the clause library seed", () => {
    for (const seed of PLATFORM_WAIVER_SEEDS.assembled) {
      for (const slug of seed.clauseSlugs) {
        expect(clauseBySlug.has(slug), `${seed.name}: missing clause ${slug}`).toBe(
          true,
        );
      }
    }
  });

  it("shares the attendee core across all three templates", () => {
    const core = [...PLATFORM_WAIVER_SEEDS.attendeeCoreSlugs];
    expect(core).toEqual([
      "released-parties-definition",
      "core-release",
      "core-assumption-of-risk",
      "amplified-sound",
      "medical-acknowledgment",
      "gross-negligence-footer",
      "severability-reformation",
      "platform-disclaimer-footer",
    ]);
    for (const seed of PLATFORM_WAIVER_SEEDS.assembled) {
      for (const slug of core) {
        expect(seed.clauseSlugs).toContain(slug);
      }
    }
  });

  it("adds the documented extras per template", () => {
    const bySlugList = Object.fromEntries(
      PLATFORM_WAIVER_SEEDS.assembled.map((seed) => [
        seed.name,
        seed.clauseSlugs.filter(
          (slug) =>
            !(PLATFORM_WAIVER_SEEDS.attendeeCoreSlugs as readonly string[]).includes(
              slug,
            ),
        ),
      ]),
    );
    expect(bySlugList["General Event Waiver"]).toEqual([]);
    expect(bySlugList["Live Music Waiver"]).toEqual([
      "physical-activity",
      "crowding",
    ]);
    expect(bySlugList["House Show / Private Event Waiver"]).toEqual([
      "private-residential",
      "byob-alcohol",
      "governing-law-tn",
    ]);
  });

  it("composes bodies whose section order matches clause sortOrder", () => {
    for (const seed of PLATFORM_WAIVER_SEEDS.assembled) {
      const clauses = seed.clauseSlugs.map((slug) => {
        const c = clauseBySlug.get(slug)!;
        return {
          id: `seed-${c.slug}`,
          slug: c.slug,
          version: 1,
          body: c.body,
          sortOrder: c.sortOrder,
        };
      });
      const { body, assembledFromClauses } = composeAssembledWaiverBody(clauses);

      // Manifest is sorted by sortOrder and body sections line up with it.
      const expectedOrder = [...clauses]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => c.slug);
      expect(assembledFromClauses.map((r) => r.clauseSlug)).toEqual(
        expectedOrder,
      );
      expect(body.split("\n\n")).toEqual(
        expectedOrder.map((slug) => clauseBySlug.get(slug)!.body),
      );
    }
  });

  it("keeps exactly one ATTENDEE default and leaves the volunteer default separate", () => {
    const attendeeDefaults = PLATFORM_WAIVER_SEEDS.assembled.filter(
      (seed) => seed.isDefault,
    );
    expect(attendeeDefaults).toHaveLength(1);
    expect(attendeeDefaults[0]!.name).toBe("General Event Waiver");

    // The volunteer waiver is NOT one of the assembled templates.
    expect(
      PLATFORM_WAIVER_SEEDS.assembled.map((seed) => seed.id),
    ).not.toContain(PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID);
  });
});

describe("waiver_template_kind migration", () => {
  const sql = readFileSync(KIND_MIGRATION_PATH, "utf8");

  it("backfills the platform volunteer waiver to kind VOLUNTEER", () => {
    expect(sql).toContain(`'${PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID}'`);
    expect(sql).toMatch(/SET "kind" = 'VOLUNTEER'/);
  });

  it("enforces one platform default per kind via a partial unique index", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "WaiverTemplate_platform_default_kind_key"\s+ON "WaiverTemplate"\("kind"\)\s+WHERE "isDefault" = true AND "orgId" IS NULL AND "humanId" IS NULL/,
    );
  });
});
