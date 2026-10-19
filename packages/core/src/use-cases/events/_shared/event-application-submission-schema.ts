import { z } from "zod";

import type { EventApplicationSubmissionRecord } from "@th/ports/repos/events";

import { normalizeQuestionOptions } from "./question-options";

export const eventApplicationSubmissionStatuses = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "EXPIRED",
  "WAITLISTED",
] as const;

export const eventApplicationQuestionTypes = [
  "SHORT_TEXT",
  "LONG_TEXT",
  "MULTI_CHOICE",
  "SINGLE_CHOICE",
] as const;

/**
 * One question captured into `questionsSnapshot` at submit time (spec D3).
 * `options` is present only for choice types.
 *
 * `options` is TOLERANT on read (belt and braces): the writer normalizes to
 * canonical `{ id, label }`, but a snapshot row written raw — before the
 * normalization fix, or by any future writer drift — must never brick the
 * queue list / review output parse for the whole event. Unknown entry shapes
 * are normalized (strings / numbers / `{value,label?}` / `{id,label}`) and
 * garbage entries are dropped, mirroring the gate's defensive parser.
 */
export const eventApplicationQuestionSnapshotEntrySchema = z.object({
  label: z.string(),
  type: z.enum(eventApplicationQuestionTypes),
  options: z
    .array(z.unknown())
    .optional()
    .transform((raw) =>
      raw === undefined ? undefined : normalizeQuestionOptions(raw),
    ),
  /**
   * The question's form position at submit time. Postgres jsonb sorts object
   * keys bytewise, so snapshot KEY order does not survive persistence — the
   * queue ranks entries by this value instead. OPTIONAL and tolerant: legacy
   * snapshots written before the field existed must still parse (the queue
   * falls back to live-form order for those).
   */
  order: z.number().int().optional(),
});

/**
 * The API projection of a submission. `formId` / `purpose` (open calls v1)
 * are internal routing fields for core's ATTEND-only guards and are NOT part
 * of the output: `z.object` strips undeclared keys, so the wire shape is
 * unchanged.
 */
export type EventApplicationSubmissionOutput = Omit<
  EventApplicationSubmissionRecord,
  "formId" | "purpose"
>;

export const eventApplicationSubmissionRecordSchema: z.ZodType<EventApplicationSubmissionOutput> =
  z.object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    humanId: z.string().uuid().nullable(),
    contactEmail: z.string().trim().max(320).nullable(),
    contactPhone: z.string().trim().max(64).nullable(),
    status: z.enum(eventApplicationSubmissionStatuses),
    answers: z.record(z.string(), z.unknown()),
    // Input-capped at 500 (review-event-application-submission); 1000 is
    // deliberate slack so an oversized legacy/edge row can't fail list reads.
    decisionReason: z.string().max(1000).nullable(),
    questionsSnapshot: z.record(
      z.string(),
      eventApplicationQuestionSnapshotEntrySchema,
    ),
    reviewerHumanId: z.string().uuid().nullable(),
    reviewedAt: z.date().nullable(),
    approvalToken: z.string().trim().nullable(),
    tokenExpiresAt: z.date().nullable(),
    inviteId: z.string().uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.date(),
    updatedAt: z.date(),
  });
