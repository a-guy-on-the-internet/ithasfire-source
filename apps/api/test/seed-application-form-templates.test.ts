import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LAUNCH_APPLICATION_FORM_TEMPLATES,
  applicationTemplateContentDiffers,
  encodeApplicationFormTemplate,
  stableStringify,
} from "../src/scripts/seed/application-form-templates";

/**
 * Pins the platform starter catalogue of application forms
 * (docs/specs/2026-08-10/application-driven-events.spec.md, Phase 4).
 *
 * The content ships on every deploy dispatch, so drift here is drift in what
 * every organizer sees the first time they turn on an application gate. The
 * spec lists the exact questions and required flags; these tests are the
 * drift guard for that list.
 */

const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/prisma/migrations/20260811150000_application_form_templates/migration.sql",
);

const SHIPPED_TYPES = new Set([
  "SHORT_TEXT",
  "LONG_TEXT",
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
]);

describe("launch application-form templates (spec Phase 4)", () => {
  it("ships exactly the six templates the spec names, in order", () => {
    expect(LAUNCH_APPLICATION_FORM_TEMPLATES.map((t) => t.name)).toEqual([
      "Performer / artist application",
      "Vendor / market stall",
      "House show RSVP",
      "Workshop / limited class",
      "Press / media accreditation",
      "Guest list / private party",
    ]);
  });

  it("every template encodes through the organizer-facing zod schema", () => {
    for (const template of LAUNCH_APPLICATION_FORM_TEMPLATES) {
      // Throws on anything an organizer could not open, apply and re-save.
      expect(() => encodeApplicationFormTemplate(template)).not.toThrow();
    }
  });

  it("uses ONLY the four shipped question types", () => {
    // The spec's "Out of scope" is explicit: a catalogue template carrying a
    // type the consumer gate cannot render reproduces the Phase-1 dead-end
    // (gap #1) across every organizer at once.
    for (const template of LAUNCH_APPLICATION_FORM_TEMPLATES) {
      for (const question of encodeApplicationFormTemplate(template)
        .questions) {
        expect(SHIPPED_TYPES.has(question.type)).toBe(true);
      }
    }
  });

  it("stores every choice option in the canonical { id, label } shape", () => {
    for (const template of LAUNCH_APPLICATION_FORM_TEMPLATES) {
      for (const question of encodeApplicationFormTemplate(template)
        .questions) {
        if (question.type === "SINGLE_CHOICE" || question.type === "MULTI_CHOICE") {
          expect(question.options).not.toBeNull();
          expect(question.options!.length).toBeGreaterThan(0);
          for (const option of question.options!) {
            expect(option).toEqual({
              id: expect.stringMatching(/^opt-\d+$/),
              label: expect.any(String),
            });
            expect(option.label.length).toBeGreaterThan(0);
          }
        } else {
          // Non-choice questions store null, never [] — the same shape an
          // EventApplicationQuestion row holds, so apply is a straight copy.
          expect(question.options).toBeNull();
        }
      }
    }
  });

  it("performer application: the spec's seven questions, required flags and intro", () => {
    const encoded = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[0]!,
    );
    expect(encoded.introText).toBe(
      "Tell us about your act — we book from these applications.",
    );
    expect(
      encoded.questions.map((q) => [q.type, q.label, q.isRequired]),
    ).toEqual([
      ["SHORT_TEXT", "Act name", true],
      ["LONG_TEXT", "Tell us about your act", true],
      ["SHORT_TEXT", "Genre", false],
      ["SHORT_TEXT", "Links to music or video", true],
      ["SINGLE_CHOICE", "Proposed set length", false],
      ["SINGLE_CHOICE", "Played here before?", false],
      ["LONG_TEXT", "Anything else?", false],
    ]);
    expect(
      encoded.questions[4]!.options!.map((o) => o.label),
    ).toEqual(["15 min", "30 min", "45 min", "60 min"]);
  });

  it("vendor stall: booth needs is MULTI_CHOICE with the four spec options", () => {
    const encoded = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[1]!,
    );
    const booth = encoded.questions.find((q) => q.label === "Booth needs");
    expect(booth?.type).toBe("MULTI_CHOICE");
    expect(booth?.options?.map((o) => o.label)).toEqual([
      "Table",
      "Power",
      "Tent space",
      "Indoor only",
    ]);
  });

  it("house show RSVP: 'Who do you know here?' is the required one", () => {
    const encoded = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[2]!,
    );
    expect(
      encoded.questions.filter((q) => q.isRequired).map((q) => q.label),
    ).toEqual(["Who do you know here?"]);
  });

  it("workshop: experience level is the required SINGLE_CHOICE", () => {
    const encoded = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[3]!,
    );
    const level = encoded.questions[0]!;
    expect(level.type).toBe("SINGLE_CHOICE");
    expect(level.isRequired).toBe(true);
    expect(level.options?.map((o) => o.label)).toEqual([
      "Beginner",
      "Intermediate",
      "Advanced",
    ]);
  });

  it("press accreditation: outlet + recent coverage links are required", () => {
    const encoded = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[4]!,
    );
    expect(
      encoded.questions.filter((q) => q.isRequired).map((q) => q.label),
    ).toEqual(["Outlet", "Recent coverage links"]);
  });

  it("guest list: the shortest possible gate — two questions", () => {
    const encoded = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[5]!,
    );
    expect(encoded.questions.map((q) => q.label)).toEqual([
      "Who invited you?",
      "Bringing anyone?",
    ]);
  });

  it("names are unique case-insensitively — the seed's identity key", () => {
    const keys = LAUNCH_APPLICATION_FORM_TEMPLATES.map((t) =>
      t.name.trim().toLowerCase(),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("refresh convergence", () => {
  it("reports NO difference for a row that round-tripped through jsonb key reordering", () => {
    // Postgres jsonb does not preserve key order. A naive JSON.stringify
    // compare would rewrite every template on every --refresh run and emit an
    // audit row each time — the churn the seed's header contract forbids.
    const desired = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[0]!,
    );
    const reordered = desired.questions.map((q) => ({
      isRequired: q.isRequired,
      options: q.options,
      label: q.label,
      description: q.description,
      type: q.type,
    }));

    expect(
      applicationTemplateContentDiffers(
        {
          id: "row-1",
          name: desired.name,
          description: desired.description,
          introText: desired.introText,
          questions: reordered as never,
          archivedAt: null,
        },
        desired,
      ),
    ).toBe(false);
  });

  it("reports a difference when content actually changed", () => {
    const desired = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[5]!,
    );
    expect(
      applicationTemplateContentDiffers(
        {
          id: "row-1",
          name: desired.name,
          description: "something else",
          introText: desired.introText,
          questions: desired.questions as never,
          archivedAt: null,
        },
        desired,
      ),
    ).toBe(true);
  });

  it("treats a hand-archived catalogue row as different (refresh un-archives it)", () => {
    const desired = encodeApplicationFormTemplate(
      LAUNCH_APPLICATION_FORM_TEMPLATES[5]!,
    );
    expect(
      applicationTemplateContentDiffers(
        {
          id: "row-1",
          name: desired.name,
          description: desired.description,
          introText: desired.introText,
          questions: desired.questions as never,
          archivedAt: new Date("2026-08-01T00:00:00Z"),
        },
        desired,
      ),
    ).toBe(true);
  });

  it("stableStringify sorts keys recursively", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
  });
});

describe("migration", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("creates the table with the spec's columns", () => {
    expect(sql).toContain('CREATE TABLE "ApplicationFormTemplate"');
    for (const column of [
      '"ownerScope" "TemplateOwnerScope" NOT NULL',
      '"ownerId" TEXT',
      '"name" TEXT NOT NULL',
      '"description" TEXT',
      '"introText" TEXT',
      '"questions" JSONB NOT NULL',
      '"isPlatform" BOOLEAN NOT NULL DEFAULT false',
      '"archivedAt" TIMESTAMP(3)',
      '"createdByHumanId" TEXT',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("indexes the list read (ownerScope, ownerId, archivedAt)", () => {
    expect(sql).toContain(
      'CREATE INDEX "ApplicationFormTemplate_ownerScope_ownerId_archivedAt_idx"',
    );
  });

  it("detaches the creator on account deletion rather than cascading", () => {
    // An org's template library must survive the departure of whoever wrote
    // it — SET NULL, never CASCADE.
    expect(sql).toContain(
      'ADD CONSTRAINT "ApplicationFormTemplate_createdByHumanId_fkey"',
    );
    expect(sql).toMatch(
      /ApplicationFormTemplate_createdByHumanId_fkey[\s\S]*?ON DELETE SET NULL/,
    );
  });
});
