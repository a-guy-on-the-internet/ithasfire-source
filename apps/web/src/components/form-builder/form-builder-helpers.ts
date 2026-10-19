/**
 * Pure mappers between the generic {@link FormBuilderQuestion} model and the
 * API's question shapes. Kept out of the component so they are unit-testable
 * without rendering anything (the same split as
 * `ticket-type-template-helpers.ts`).
 */

import {
  isChoiceType,
  makeFormBuilderKey,
  type ApplicationQuestionType,
  type FormBuilderOption,
  type FormBuilderQuestion,
} from "./FormBuilder";

/** A question as the API returns it (event question row OR template entry). */
export type ApiQuestionShape = {
  id?: string;
  type: ApplicationQuestionType;
  label: string;
  description?: string | null;
  options?: unknown;
  isRequired: boolean;
};

/**
 * Read the display text out of any at-rest option shape the API might hand
 * back — canonical `{ id, label }`, builder `{ value }`, or a bare string
 * (legacy rows). Mirrors the server's `normalizeQuestionOptions` tolerance;
 * without it a legacy template renders a column of blank option inputs.
 */
export function toBuilderOptions(raw: unknown): FormBuilderOption[] {
  if (!Array.isArray(raw)) return [];
  const out: FormBuilderOption[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ value: entry });
      continue;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      out.push({ value: String(entry) });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : null;
      const value = typeof record.value === "string" ? record.value : null;
      // Canonical shape puts the display text in `label`; builder shape puts
      // it in `value`. Prefer whichever is non-blank.
      const text = label?.trim() ? label : value;
      if (text?.trim()) out.push({ value: text });
    }
  }
  return out;
}

/** API question → builder question. `id` becomes both key and serverId. */
export function toBuilderQuestion(
  question: ApiQuestionShape,
): FormBuilderQuestion {
  return {
    key: question.id ?? makeFormBuilderKey(),
    ...(question.id ? { serverId: question.id } : {}),
    type: question.type,
    label: question.label,
    description: question.description ?? "",
    options: isChoiceType(question.type)
      ? toBuilderOptions(question.options)
      : [],
    isRequired: question.isRequired,
  };
}

export function toBuilderQuestions(
  questions: readonly ApiQuestionShape[],
): FormBuilderQuestion[] {
  return questions.map(toBuilderQuestion);
}

/**
 * Builder question → the API's write payload for ONE question, minus the
 * routing fields (formId / questionId / order) the caller supplies.
 *
 * Blank options are dropped: an empty trailing option row is how the editor
 * offers "add another", not something the organizer meant to save. Non-choice
 * types send `undefined` rather than `[]` — the server refuses options on a
 * non-choice question (OPTIONS_NOT_ALLOWED), and `[]` is still "options".
 */
export function toApiQuestionFields(question: FormBuilderQuestion): {
  type: ApplicationQuestionType;
  label: string;
  description: string | undefined;
  options: FormBuilderOption[] | undefined;
  isRequired: boolean;
} {
  const options = isChoiceType(question.type)
    ? question.options.filter((option) => option.value.trim())
    : undefined;
  return {
    type: question.type,
    label: question.label.trim(),
    description: question.description.trim() || undefined,
    options,
    isRequired: question.isRequired,
  };
}

/**
 * The template `questions` payload: the whole array in one shot, with blank
 * option rows dropped and `description` sent as `null` (templates store null,
 * not undefined, so a cleared description round-trips).
 */
export function toTemplateQuestionsPayload(
  questions: readonly FormBuilderQuestion[],
): Array<{
  type: ApplicationQuestionType;
  label: string;
  description: string | null;
  options?: FormBuilderOption[];
  isRequired: boolean;
}> {
  return questions
    .filter((question) => question.label.trim().length > 0)
    .map((question) => {
      const fields = toApiQuestionFields(question);
      return {
        type: fields.type,
        label: fields.label,
        description: fields.description ?? null,
        ...(fields.options ? { options: fields.options } : {}),
        isRequired: fields.isRequired,
      };
    });
}

/**
 * Stable signature of a question's CONTENT (not its identity or position),
 * used to decide whether a persisted row actually needs an update call.
 * Without it, saving a form re-POSTs every question on every save.
 */
export function questionSignature(question: FormBuilderQuestion): string {
  const fields = toApiQuestionFields(question);
  return JSON.stringify([
    fields.type,
    fields.label,
    fields.description ?? "",
    (fields.options ?? []).map((option) => option.value),
    fields.isRequired,
  ]);
}

/**
 * The FIRST choice question that would be REFUSED by the server for having no
 * usable options (`OPTIONS_REQUIRED`), or null when the list is savable.
 *
 * Called by every save handler before it posts, so the organizer sees the
 * problem next to the form instead of a round-trip failure — and, in the
 * event builder, instead of a PARTIAL save (that loop posts one question at a
 * time, so a bad question halfway down commits everything above it and then
 * throws).
 *
 * Unlabelled cards are ignored: an empty card is one the organizer opened and
 * abandoned, and the save handlers skip those anyway.
 */
export function findChoiceQuestionMissingOptions(
  questions: readonly FormBuilderQuestion[],
): FormBuilderQuestion | null {
  return (
    questions.find(
      (question) =>
        isChoiceType(question.type) &&
        question.label.trim().length > 0 &&
        question.options.filter((option) => option.value.trim()).length === 0,
    ) ?? null
  );
}

/** Boolean form of {@link findChoiceQuestionMissingOptions}. */
export function hasEmptyChoiceOptions(
  questions: readonly FormBuilderQuestion[],
): boolean {
  return findChoiceQuestionMissingOptions(questions) !== null;
}

/**
 * Does the builder hold edits that are not yet on the server?
 *
 * This exists because applying a template RE-HYDRATES the builder from the
 * server. Without the check, an organizer who added two questions and trashed
 * a third could apply a template and watch the two vanish and the deletion
 * silently revert — the same save-vs-local asymmetry the "Save as template"
 * dialog warns about in the other direction, but destructive instead of
 * merely surprising.
 *
 * Four independent ways to be dirty; all four must be checked, because each
 * one alone is invisible to the others:
 *   1. a NEW question with a real label (a blank draft card does not count —
 *      the save handlers skip it, so it is not pending work);
 *   2. a persisted question whose CONTENT changed;
 *   3. a persisted question that MOVED (content-identical, position isn't);
 *   4. a queued delete.
 */
export function hasUnsavedFormChanges(input: {
  questions: readonly FormBuilderQuestion[];
  /** serverId → content signature as loaded. */
  loadedSignatures: ReadonlyMap<string, string>;
  /** serverId → index as loaded. */
  loadedOrder: ReadonlyMap<string, number>;
  pendingDeletes: readonly string[];
}): boolean {
  if (input.pendingDeletes.length > 0) return true;

  return input.questions.some((question, index) => {
    if (!question.serverId) {
      return question.label.trim().length > 0;
    }
    if (input.loadedSignatures.get(question.serverId) !== questionSignature(question)) {
      return true;
    }
    return input.loadedOrder.get(question.serverId) !== index;
  });
}
