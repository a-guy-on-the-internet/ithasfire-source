import { z } from "zod";

import type {
  EventApplicationQuestionRecord,
  EventApplicationQuestionSnapshotEntry,
} from "@th/ports/repos/events";

import { sanitizePlainText } from "../../../lib/sanitize-plain-text";
import { normalizeQuestionOptions } from "./question-options";

/**
 * Application answers: the boundary schema, the server-side required-answer
 * check and the submit-time question snapshot. Shared by the attendee gate
 * (submit-event-application) and open-call applications (open calls v1
 * step 4), so both validate answers exactly the same way.
 */

const ANSWERS_MAX_KEYS = 50;
const ANSWERS_MAX_KEY_LENGTH = 200;
const ANSWERS_MAX_SERIALIZED_LENGTH = 20_000;

/**
 * Sanitize a single answer value: strip HTML + control/bidi chars from
 * string values (and string elements of arrays, for multi-choice answers).
 * Non-string scalars (numbers, booleans) and everything else pass through
 * untouched — this is defense-in-depth for a flat-ish question-id → answer
 * record, not a general-purpose deep sanitizer.
 */
function sanitizeAnswerValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizePlainText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" ? sanitizePlainText(item) : item,
    );
  }
  return value;
}

export const answersSchema = z
  .record(z.string().max(ANSWERS_MAX_KEY_LENGTH), z.unknown())
  .refine((obj) => Object.keys(obj).length <= ANSWERS_MAX_KEYS, {
    message: "Too many answers",
  })
  .refine(
    (obj) => JSON.stringify(obj).length <= ANSWERS_MAX_SERIALIZED_LENGTH,
    { message: "Answer payload too large" },
  )
  .transform((obj) => {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeAnswerValue(value);
    }
    return sanitized;
  })
  .default({});

const CHOICE_QUESTION_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);

/**
 * Whether a question's raw `options` value contains at least one renderable
 * entry. PARITY RULE: mirrors the gate's `parseQuestionOptions`
 * (packages/ui EventApplicationGate.tsx) — plain strings, finite numbers,
 * `{ value, label? }` (builder shape) and `{ id, label }` (canonical shape)
 * all count when their display text is non-blank; anything else is dropped.
 * The two layers MUST agree: a required choice question the client renders
 * nothing for (zero valid options) must never dead-end submission with an
 * unfixable server rejection.
 */
function hasRenderableOptions(raw: unknown): boolean {
  if (!Array.isArray(raw)) {
    return false;
  }

  return raw.some((entry) => {
    if (typeof entry === "string") {
      return entry.trim().length > 0;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return true;
    }
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : null;
      const value = typeof record.value === "string" ? record.value : null;
      return Boolean(label?.trim() || value?.trim());
    }
    return false;
  });
}

/**
 * Whether an answer counts as provided — mirrors the gate's
 * `isAnswerProvided`: non-blank string for text/single-choice, at least one
 * non-blank string element for multi-choice. Unknown future types never
 * block submission.
 */
function isAnswerProvided(
  question: EventApplicationQuestionRecord,
  value: unknown,
): boolean {
  switch (question.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT":
    case "SINGLE_CHOICE":
      return typeof value === "string" && value.trim().length > 0;
    case "MULTI_CHOICE":
      return (
        Array.isArray(value) &&
        value.some((item) => typeof item === "string" && item.trim().length > 0)
      );
    default:
      return true;
  }
}

/**
 * Server-side mirror of the gate's `hasMissingRequiredAnswers`: a required
 * question without a valid answer blocks submission — EXCEPT a required
 * choice question with zero renderable options, which is unanswerable (the
 * client renders nothing for it and deliberately doesn't gate on it).
 */
export function hasMissingRequiredAnswers(
  questions: EventApplicationQuestionRecord[],
  answers: Record<string, unknown>,
): boolean {
  return questions.some((question) => {
    if (!question.isRequired) {
      return false;
    }

    if (
      CHOICE_QUESTION_TYPES.has(question.type) &&
      !hasRenderableOptions(question.options)
    ) {
      return false;
    }

    return !isAnswerProvided(question, answers[question.id]);
  });
}

/**
 * Build the submit-time question snapshot (spec D3):
 * `{ [questionId]: { label, type, options?, order } }` — `options` only for
 * choice types (and only when the question actually has some).
 *
 * Options are NORMALIZED to the canonical `{ id, label }` shape via the
 * shared helper, never copied verbatim: a legacy question row whose options
 * were stored as `["15 min"]` or `[{ value: "Yes" }]` would otherwise poison
 * the snapshot and permanently fail the strict record-schema parse on every
 * subsequent queue list / review for that event.
 *
 * `order` (the question's form position) is captured per entry because
 * Postgres jsonb sorts object keys bytewise — snapshot KEY order does not
 * survive persistence, so the review queue ranks entries by this value.
 */
export function buildQuestionsSnapshot(
  questions: EventApplicationQuestionRecord[],
): Record<string, EventApplicationQuestionSnapshotEntry> {
  const snapshot: Record<string, EventApplicationQuestionSnapshotEntry> = {};
  for (const question of questions) {
    const options = CHOICE_QUESTION_TYPES.has(question.type)
      ? normalizeQuestionOptions(question.options)
      : [];
    snapshot[question.id] = {
      label: question.label,
      type: question.type,
      ...(options.length > 0 ? { options } : {}),
      order: question.order,
    };
  }
  return snapshot;
}
