/**
 * application-form-templates.ts — the platform starter catalogue of
 * application forms (docs/specs/2026-08-10/application-driven-events.spec.md,
 * Phase 4 "Platform starter catalogue").
 *
 * Six platform-curated templates, seeded through the normal seed path so dev,
 * staging and prod start from the same reviewed baseline. A catalogue row is
 * an ordinary `ApplicationFormTemplate` with `ownerId = null` and
 * `isPlatform = true`. Sibling of ticket-packs.ts / volunteer-packs.ts with
 * the SAME contract, because this seed also runs on every deploy dispatch.
 *
 * There is no "pack" layer here: application templates are a flat catalogue
 * (the spec's model has no pack column), so identity is simply the name.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 *
 * Keyed on stable identity, never on row ids: a catalogue template on its
 * case-folded `name` among `isPlatform: true` rows. A re-seed must not churn
 * ids — nothing references them today (fork-on-use copies rows out), but an
 * id-churning seed makes the audit log unreadable.
 *
 * ── DEFAULT MODE IS INSTALL-ONLY ───────────────────────────────────────────
 *
 *   - CREATE templates that do not exist. A fresh environment converges on the
 *     reviewed git baseline; content added to this file later still propagates.
 *   - NEVER update an existing row's content. Copy a staff member fixed in
 *     prod stays fixed.
 *   - NEVER delete. Retiring catalogue content is a deliberate staff action.
 *
 * Two opt-ins widen that, and BOTH are off in deploy workflows:
 *
 *   - `refresh` — push this file's CONTENT over existing rows.
 *   - `prune`   — delete catalogue rows the baseline no longer names, plus
 *                 case-folded duplicates. Pinned to `isPlatform: true`, so an
 *                 organizer's owned template is never reachable from here.
 *
 * `seed-data.ts` passes BOTH: `pnpm seed:dev` recreates the schema, so full
 * convergence is the point.
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 *
 * A converged re-seed writes NOTHING. Changes are recorded against
 * `entity: "application_form_template"` with actions
 * `seed_installed` / `seed_refreshed` / `seed_pruned`.
 *
 * ── Question types ─────────────────────────────────────────────────────────
 *
 * ONLY the four shipped types (SHORT_TEXT, LONG_TEXT, SINGLE_CHOICE,
 * MULTI_CHOICE). The spec's "Out of scope" is explicit that templates
 * deliberately use only shipped types — a catalogue template carrying a type
 * the consumer gate cannot render would reproduce the Phase-1 dead-end at
 * scale. Options are encoded through the SAME zod schema the organizer-facing
 * write path uses, so every seeded option lands in the canonical
 * `{ id, label }` shape and a seeded template always round-trips through
 * apply.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { applicationTemplateQuestionsSchema } from "@th/core/use-cases/application-form-templates/schemas";

// ── Catalogue ────────────────────────────────────────────────────────────────

type SeedQuestion = {
  type: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_CHOICE" | "MULTI_CHOICE";
  label: string;
  description?: string;
  /** Display text for the choice types; encoded to `{ id, label }`. */
  options?: string[];
  required?: boolean;
};

type SeedTemplate = {
  name: string;
  description: string;
  introText?: string;
  questions: SeedQuestion[];
};

export const LAUNCH_APPLICATION_FORM_TEMPLATES: SeedTemplate[] = [
  {
    name: "Performer / artist application",
    description:
      "For open calls and booking submissions — collects the act, links, and set length you need to make a booking decision.",
    introText: "Tell us about your act — we book from these applications.",
    questions: [
      { type: "SHORT_TEXT", label: "Act name", required: true },
      { type: "LONG_TEXT", label: "Tell us about your act", required: true },
      { type: "SHORT_TEXT", label: "Genre" },
      {
        type: "SHORT_TEXT",
        label: "Links to music or video",
        required: true,
      },
      {
        type: "SINGLE_CHOICE",
        label: "Proposed set length",
        options: ["15 min", "30 min", "45 min", "60 min"],
      },
      {
        type: "SINGLE_CHOICE",
        label: "Played here before?",
        options: ["Yes", "No"],
      },
      { type: "LONG_TEXT", label: "Anything else?" },
    ],
  },
  {
    name: "Vendor / market stall",
    description:
      "For markets, fairs and pop-ups — what they sell, what they need from you, and whether they're licensed.",
    questions: [
      { type: "SHORT_TEXT", label: "Stall name", required: true },
      { type: "LONG_TEXT", label: "What do you sell?", required: true },
      {
        type: "MULTI_CHOICE",
        label: "Booth needs",
        options: ["Table", "Power", "Tent space", "Indoor only"],
      },
      { type: "SHORT_TEXT", label: "Links to your work" },
      { type: "SHORT_TEXT", label: "Permits or licences held" },
    ],
  },
  {
    name: "House show RSVP",
    description:
      "For living-room shows and private spaces — vouching, headcount and a note to the host, without asking for an address in return.",
    questions: [
      {
        type: "SINGLE_CHOICE",
        label: "How did you hear about this?",
        options: [
          "Friend of the host",
          "Friend of a performer",
          "Been before",
          "Other",
        ],
      },
      { type: "SHORT_TEXT", label: "Who do you know here?", required: true },
      {
        type: "SINGLE_CHOICE",
        label: "Bringing anyone?",
        options: ["Just me", "+1", "+2"],
      },
      { type: "LONG_TEXT", label: "Message to the host" },
    ],
  },
  {
    name: "Workshop / limited class",
    description:
      "For classes with limited places — experience level, goals, and access needs so you can group people well.",
    questions: [
      {
        type: "SINGLE_CHOICE",
        label: "Experience level",
        options: ["Beginner", "Intermediate", "Advanced"],
        required: true,
      },
      {
        type: "LONG_TEXT",
        label: "What do you want to get out of it?",
        required: true,
      },
      { type: "SHORT_TEXT", label: "Access or accommodation needs" },
    ],
  },
  {
    name: "Press / media accreditation",
    description:
      "For photo pits and press lists — outlet, role, and what they've actually published.",
    questions: [
      { type: "SHORT_TEXT", label: "Outlet", required: true },
      {
        type: "SINGLE_CHOICE",
        label: "Role",
        options: ["Photographer", "Writer", "Video", "Podcast", "Other"],
      },
      { type: "LONG_TEXT", label: "Recent coverage links", required: true },
      { type: "LONG_TEXT", label: "Planned coverage" },
    ],
  },
  {
    name: "Guest list / private party",
    description:
      "The shortest possible gate — who vouched for them, and how many are coming.",
    questions: [
      { type: "SHORT_TEXT", label: "Who invited you?", required: true },
      {
        type: "SINGLE_CHOICE",
        label: "Bringing anyone?",
        options: ["Just me", "+1", "+2"],
      },
    ],
  },
];

// ── Validation / encoding ────────────────────────────────────────────────────

export type EncodedApplicationTemplate = {
  name: string;
  description: string;
  introText: string | null;
  questions: Array<{
    type: SeedQuestion["type"];
    label: string;
    description: string | null;
    options: Array<{ id: string; label: string }> | null;
    isRequired: boolean;
  }>;
};

/**
 * Encode + validate through the SAME zod schema the organizer write path uses
 * (`applicationTemplateQuestionsSchema`). Running the catalogue through the
 * real schema guarantees a seeded template is one an organizer can open,
 * apply, and re-save — and that its options land in the canonical
 * `{ id, label }` shape. Exported so a unit test can assert it without a
 * database.
 */
export function encodeApplicationFormTemplate(
  template: SeedTemplate,
): EncodedApplicationTemplate {
  const parsed = applicationTemplateQuestionsSchema.parse(
    template.questions.map((question) => ({
      type: question.type,
      label: question.label,
      description: question.description ?? null,
      // Display strings are lifted into the BUILDER option shape
      // (`{ value }`) — the exact shape the web form builder posts. The
      // schema's `normalizeQuestionOptions` transform then assigns
      // deterministic positional ids (`opt-1`, `opt-2`, …) and yields the
      // canonical `{ id, label }` pairs that get stored. Going through the
      // organizer path (rather than hand-writing ids here) is what makes a
      // seeded template provably identical to a hand-authored one.
      options: question.options?.map((value) => ({ value })) ?? null,
      isRequired: question.required ?? false,
    })),
  );

  return {
    name: template.name,
    description: template.description,
    introText: template.introText ?? null,
    questions: parsed.map((question) => ({
      type: question.type,
      label: question.label,
      description: question.description ?? null,
      options: question.options ?? null,
      isRequired: question.isRequired,
    })),
  };
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export type ApplicationFormTemplateSeedOptions = {
  /** Overwrite existing CONTENT with this file's baseline. OFF by default. */
  refresh?: boolean;
  /** Delete catalogue rows the baseline no longer names. OFF by default. */
  prune?: boolean;
};

type ExistingTemplate = {
  id: string;
  name: string;
  description: string | null;
  introText: string | null;
  questions: Prisma.JsonValue;
  archivedAt: Date | null;
};

const foldKey = (value: string) => value.trim().toLowerCase();

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic JSON encoding: object keys sorted recursively.
 *
 * Postgres `jsonb` does NOT preserve key order, so a template that round-trips
 * through the database comes back with the same content under a different key
 * order. A naive `JSON.stringify` compare therefore NEVER matches, and a
 * converged `--refresh` run would rewrite every template and emit an audit row
 * on every single run — the exact churn the header contract forbids. Copied in
 * spirit (and behaviour) from seed/ticket-packs.ts's `stableStringify`.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic duplicate handling — see ticket-packs.ts's groupByKey. */
function groupByKey<T>(
  rows: readonly T[],
  key: (row: T) => string,
  order: (a: T, b: T) => number,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of [...rows].sort(order)) {
    const bucket = out.get(key(row));
    if (bucket) bucket.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

/**
 * Content comparison for refresh mode. Questions are compared through
 * {@link stableStringify} — see its doc comment. Exported for the convergence
 * unit test.
 */
export function applicationTemplateContentDiffers(
  existing: ExistingTemplate,
  desired: EncodedApplicationTemplate,
): boolean {
  return (
    existing.name !== desired.name ||
    existing.description !== desired.description ||
    existing.introText !== desired.introText ||
    stableStringify(existing.questions) !==
      stableStringify(desired.questions) ||
    // A catalogue template is never archived; a hand-archived row converges
    // back on the reviewed baseline under refresh.
    existing.archivedAt !== null
  );
}

/**
 * Install the starter catalogue.
 *
 * INSTALL-ONLY by default — creates what is missing, updates nothing, deletes
 * nothing. A converged re-seed performs zero writes and emits zero audit rows.
 *
 * Written with plain Prisma calls rather than through a use case, matching
 * ticket-packs.ts / volunteer-packs.ts: the organizer-facing create use case
 * requires an actorHumanId for its RBAC check and cannot mint a platform row
 * at all (`isPlatform` is deliberately not settable there). Content is still
 * validated against the real schema by `encodeApplicationFormTemplate`, and
 * every change writes an AuditLog row naming the seed as the actor.
 */
export async function ensureApplicationFormTemplates(
  prisma: PrismaClient,
  options: ApplicationFormTemplateSeedOptions = {},
) {
  const refresh = options.refresh ?? false;
  const prune = options.prune ?? false;

  console.log(
    `Seeding platform application-form templates (refresh=${refresh}, prune=${prune})...`,
  );

  const summary = {
    templateCount: 0,
    created: 0,
    updated: 0,
    removed: 0,
    withheldDeletes: 0,
  };

  const encoded = LAUNCH_APPLICATION_FORM_TEMPLATES.map(
    encodeApplicationFormTemplate,
  );

  const seenNames = new Set<string>();
  for (const template of encoded) {
    const key = foldKey(template.name);
    if (seenNames.has(key)) {
      throw new Error(
        `[application-form-templates] catalogue lists "${template.name}" twice`,
      );
    }
    seenNames.add(key);
  }

  // PLATFORM-ONLY: an organizer's owned template must never be reachable here.
  const existingRows: ExistingTemplate[] =
    await prisma.applicationFormTemplate.findMany({
      where: { isPlatform: true },
      select: {
        id: true,
        name: true,
        description: true,
        introText: true,
        questions: true,
        archivedAt: true,
      },
    });

  const byName = groupByKey<ExistingTemplate>(
    existingRows,
    (row) => foldKey(row.name),
    (a, b) => byId(a.id, b.id),
  );
  const unclaimed = new Set(byName.keys());

  const createdNames: string[] = [];
  const updatedNames: string[] = [];
  const candidateDeletes: { id: string; name: string }[] = [];

  for (const template of encoded) {
    const key = foldKey(template.name);
    unclaimed.delete(key);
    const bucket = byName.get(key) ?? [];
    const match = bucket[0];

    if (!match) {
      await prisma.applicationFormTemplate.create({
        data: {
          ownerId: null,
          isPlatform: true,
          // NOT NULL column; ORGANIZATION by convention on catalogue rows and
          // ignored (same convention as TicketTypeTemplate).
          ownerScope: "ORGANIZATION",
          name: template.name,
          description: template.description,
          introText: template.introText,
          questions: template.questions as unknown as Prisma.InputJsonValue,
          createdByHumanId: null,
        },
        select: { id: true },
      });
      createdNames.push(template.name);
      summary.created += 1;
    } else if (refresh && applicationTemplateContentDiffers(match, template)) {
      await prisma.applicationFormTemplate.update({
        where: { id: match.id },
        data: {
          name: template.name,
          description: template.description,
          introText: template.introText,
          questions: template.questions as unknown as Prisma.InputJsonValue,
          archivedAt: null,
        },
        select: { id: true },
      });
      updatedNames.push(template.name);
      summary.updated += 1;
    }
    summary.templateCount += 1;

    // Case-folded duplicates of a template the baseline DOES name.
    for (const dup of bucket.slice(1)) {
      candidateDeletes.push({ id: dup.id, name: dup.name });
    }
  }

  for (const key of unclaimed) {
    for (const row of byName.get(key) ?? []) {
      candidateDeletes.push({ id: row.id, name: row.name });
    }
  }

  // ── Deletes + audit, in one transaction ────────────────────────────────────
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  let deleteAt = -1;

  if (prune) {
    if (candidateDeletes.length > 0) {
      deleteAt = ops.length;
      ops.push(
        prisma.applicationFormTemplate.deleteMany({
          // `isPlatform: true` pinned again at the delete: an organizer's own
          // template is not this seed's to remove.
          where: {
            id: { in: candidateDeletes.map((row) => row.id) },
            isPlatform: true,
          },
        }),
      );
      ops.push(
        prisma.auditLog.create({
          data: {
            entity: "application_form_template",
            entityId: "catalogue",
            action: "application_form_template.seed_pruned",
            data: {
              actor: "seed:application-form-templates",
              removedNames: candidateDeletes.map((row) => row.name),
            },
          },
        }),
      );
    }
  } else {
    summary.withheldDeletes += candidateDeletes.length;
  }

  if (createdNames.length > 0) {
    ops.push(
      prisma.auditLog.create({
        data: {
          entity: "application_form_template",
          entityId: "catalogue",
          action: "application_form_template.seed_installed",
          data: {
            actor: "seed:application-form-templates",
            createdTemplates: createdNames,
          },
        },
      }),
    );
  }

  if (updatedNames.length > 0) {
    ops.push(
      prisma.auditLog.create({
        data: {
          entity: "application_form_template",
          entityId: "catalogue",
          action: "application_form_template.seed_refreshed",
          data: {
            actor: "seed:application-form-templates",
            updatedTemplates: updatedNames,
          },
        },
      }),
    );
  }

  if (ops.length > 0) {
    const results = await prisma.$transaction(ops);
    if (deleteAt >= 0) {
      summary.removed += (results[deleteAt] as { count: number }).count;
    }
  }

  const changes = [
    summary.created > 0 ? `+${summary.created} template(s)` : null,
    summary.updated > 0 ? `~${summary.updated} template(s)` : null,
    summary.removed > 0 ? `-${summary.removed} template(s)` : null,
  ].filter(Boolean);

  console.log(
    `  ${summary.templateCount} application-form templates — ` +
      (changes.length > 0 ? `changes: ${changes.join(", ")}` : "no changes"),
  );

  if (summary.withheldDeletes > 0) {
    console.log(
      `  NOTE: ${summary.withheldDeletes} template(s) in the database are not ` +
        `named by the git baseline and were LEFT IN PLACE (pruning is off by ` +
        `default — pass --prune to remove them).`,
    );
  }

  return { ...summary, refresh, prune };
}
