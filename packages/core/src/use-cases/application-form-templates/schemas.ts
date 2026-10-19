import { z } from "zod";

import {
  plainTextMultilineOptional,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { normalizeQuestionOptions } from "../events/_shared/question-options";

const ownerScopeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

/**
 * Only the FOUR shipped question types. The spec's "Out of scope" is explicit:
 * NUMBER/DATE/FILE etc. are future work and "templates deliberately use only
 * shipped types" — a template carrying a type the gate cannot render would
 * reproduce the Phase 1 dead-end (gap #1) at scale.
 */
export const applicationQuestionTypes = [
  "SHORT_TEXT",
  "LONG_TEXT",
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
] as const;

const CHOICE_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);

/** CANONICAL at-rest option shape — same as EventApplicationQuestion.options. */
const canonicalOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: plainTextRequired(200),
  })
  .strict();

/**
 * Builder-facing option shape (`{ value, label? }`, display text in `value`),
 * accepted for the same reason `upsert-event-application-question` accepts it:
 * the web FormBuilder writes options that way, and rejecting it there was a
 * live `invalid_input` on every choice-question save.
 */
const builderOptionSchema = z
  .object({
    value: plainTextRequired(200),
    label: plainTextOptional(200).optional(),
  })
  .strict();

/**
 * Accept either per-item shape, then NORMALIZE the whole array to canonical
 * `{ id, label }` through the SHARED helper — the one the question write path,
 * the submit-time snapshot and the tolerant record read all use. Templates
 * must store exactly what a question row stores, because apply copies them
 * across verbatim.
 */
const optionsInputSchema = z
  .array(z.union([canonicalOptionSchema, builderOptionSchema]))
  .max(32)
  .transform((options) => normalizeQuestionOptions(options));

export const applicationTemplateQuestionSchema = z
  .object({
    type: z.enum(applicationQuestionTypes),
    label: plainTextRequired(200),
    description: plainTextMultilineOptional(2000).nullable().optional(),
    options: optionsInputSchema.nullable().optional(),
    isRequired: z.boolean().default(false),
  })
  .strict()
  .superRefine((question, ctx) => {
    const needsOptions = CHOICE_TYPES.has(question.type);
    const count = question.options?.length ?? 0;
    // Mirrors resolveOptions() in upsert-event-application-question: a
    // template that would be REFUSED at apply time must be refused at save
    // time, or the organizer discovers it only when the fork half-fails.
    if (needsOptions && count === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "options_required",
      });
    }
    if (!needsOptions && count > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "options_not_allowed",
      });
    }
  });

/**
 * Ordered question array. Position IS the order (spec D4 stores an "ordered
 * array"), so no `order` field exists to disagree with it. Empty is allowed:
 * an intro-only template (the gate still collects the built-in defaults) is a
 * legitimate thing to save, and refusing it would make "save as template" fail
 * on a form the organizer has not finished yet.
 */
export const applicationTemplateQuestionsSchema = z
  .array(applicationTemplateQuestionSchema)
  .max(50);

export const applicationFormTemplateDtoSchema = z
  .object({
    id: z.uuid(),
    ownerScope: ownerScopeSchema,
    /** Null = platform catalogue row. Resolved deliberately by every consumer. */
    ownerId: z.uuid().nullable(),
    name: z.string().trim().min(1).max(80),
    description: z.string().nullable(),
    introText: z.string().nullable(),
    questions: z.array(
      z.object({
        type: z.enum(applicationQuestionTypes),
        label: z.string(),
        description: z.string().nullable(),
        options: z.array(canonicalOptionSchema).nullable(),
        isRequired: z.boolean(),
      }),
    ),
    /** True only on catalogue rows — read-only to organizers. */
    isPlatform: z.boolean(),
    archivedAt: z.date().nullable(),
    createdByHumanId: z.uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

// ── list ─────────────────────────────────────────────────────────────────────

export const listApplicationFormTemplatesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
  })
  .strict();

export const listApplicationFormTemplatesResultSchema = z
  .object({
    /** The caller's own non-archived rows, newest first. */
    items: z.array(applicationFormTemplateDtoSchema),
    /** The platform starter catalogue — visible to every organizer. */
    platform: z.array(applicationFormTemplateDtoSchema),
  })
  .strict();

// ── create ───────────────────────────────────────────────────────────────────

export const createApplicationFormTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: plainTextRequired(80),
    description: plainTextOptional(500).nullable().optional(),
    introText: plainTextMultilineOptional(2000).nullable().optional(),
    questions: applicationTemplateQuestionsSchema,
    clientKey: z.string().min(8),
  })
  .strict();

/**
 * ID + name, never the full DTO. Every write here is idempotency-wrapped, and
 * a committed idempotency record round-trips through JSON: a `Date` in the
 * stored response would come back a STRING on replay while still typed
 * `Date`. `createTicketTypeTemplate` returns `{ templateId }` for exactly this
 * reason. Callers refetch the list.
 */
export const createApplicationFormTemplateResultSchema = z
  .object({ templateId: z.uuid(), name: z.string() })
  .strict();

// ── update ───────────────────────────────────────────────────────────────────

/**
 * Presence semantics throughout: an ABSENT key leaves the stored value alone,
 * an explicit `null` clears it. The template editor and a future rename-only
 * surface write different slices of the same row.
 */
export const updateApplicationFormTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    templateId: z.uuid(),
    name: plainTextRequired(80).optional(),
    description: plainTextOptional(500).nullable().optional(),
    introText: plainTextMultilineOptional(2000).nullable().optional(),
    questions: applicationTemplateQuestionsSchema.optional(),
    clientKey: z.string().min(8),
  })
  .strict();

/** ID + name — see the note on the create result. */
export const updateApplicationFormTemplateResultSchema = z
  .object({ templateId: z.uuid(), name: z.string() })
  .strict();

// ── archive ──────────────────────────────────────────────────────────────────

export const archiveApplicationFormTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    templateId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const archiveApplicationFormTemplateResultSchema = z
  .object({ ok: z.literal(true) })
  .strict();

// ── apply (fork-on-use) ──────────────────────────────────────────────────────

export const applyApplicationFormTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    templateId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const applyApplicationFormTemplateResultSchema = z
  .object({
    formId: z.uuid(),
    /** Ids of the question rows this apply created, in template order. */
    createdQuestionIds: z.array(z.uuid()),
    /** Labels of the questions created — what the UI reports back. */
    created: z.array(z.string()),
  })
  .strict();

/**
 * Apply a PERFORM template onto an existing open call (open calls v1,
 * FR-001: "it starts from a blank form or a template"). Keyed by the call's
 * form id, so it works for an event call and a series call alike. The call
 * must exist first: pay is required on a call and a template carries none.
 */
export const applyApplicationFormTemplateToOpenCallInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    templateId: z.uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

// ── save-as-template (snapshot up) ───────────────────────────────────────────

export const saveFormAsApplicationTemplateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    ownerScope: ownerScopeSchema,
    ownerId: z.uuid(),
    name: plainTextRequired(80),
    description: plainTextOptional(500).nullable().optional(),
    clientKey: z.string().min(8),
  })
  .strict();

/** ID + name + how many questions were snapshotted — see the create note. */
export const saveFormAsApplicationTemplateResultSchema = z
  .object({
    templateId: z.uuid(),
    name: z.string(),
    questionCount: z.number().int().min(0),
  })
  .strict();

// ── types ────────────────────────────────────────────────────────────────────

export type ApplicationFormTemplateDTO = z.infer<
  typeof applicationFormTemplateDtoSchema
>;
export type ApplicationTemplateQuestionInput = z.infer<
  typeof applicationTemplateQuestionSchema
>;
export type ListApplicationFormTemplatesInput = z.infer<
  typeof listApplicationFormTemplatesInputSchema
>;
export type ListApplicationFormTemplatesResult = z.infer<
  typeof listApplicationFormTemplatesResultSchema
>;
export type CreateApplicationFormTemplateInput = z.infer<
  typeof createApplicationFormTemplateInputSchema
>;
export type CreateApplicationFormTemplateResult = z.infer<
  typeof createApplicationFormTemplateResultSchema
>;
export type UpdateApplicationFormTemplateInput = z.infer<
  typeof updateApplicationFormTemplateInputSchema
>;
export type UpdateApplicationFormTemplateResult = z.infer<
  typeof updateApplicationFormTemplateResultSchema
>;
export type ArchiveApplicationFormTemplateInput = z.infer<
  typeof archiveApplicationFormTemplateInputSchema
>;
export type ArchiveApplicationFormTemplateResult = z.infer<
  typeof archiveApplicationFormTemplateResultSchema
>;
export type ApplyApplicationFormTemplateInput = z.infer<
  typeof applyApplicationFormTemplateInputSchema
>;
export type ApplyApplicationFormTemplateToOpenCallInput = z.infer<
  typeof applyApplicationFormTemplateToOpenCallInputSchema
>;
export type ApplyApplicationFormTemplateResult = z.infer<
  typeof applyApplicationFormTemplateResultSchema
>;
export type SaveFormAsApplicationTemplateInput = z.infer<
  typeof saveFormAsApplicationTemplateInputSchema
>;
export type SaveFormAsApplicationTemplateResult = z.infer<
  typeof saveFormAsApplicationTemplateResultSchema
>;
