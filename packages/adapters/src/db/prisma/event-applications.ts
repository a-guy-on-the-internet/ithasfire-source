import {
  buildOffsetPageInfo,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import type {
  ApplicationFormPurpose,
  CountApplicationSubmissionsInput,
  CreateEventApplicationSubmissionInput,
  EventApplicationFormRecord,
  EventApplicationQuestionRecord,
  EventApplicationSubmissionRecord,
  EventApplicationQuestionSnapshotEntry,
  EventApplicationsRepo,
  FindOpenApplicationSubmissionInput,
  ListApplicationSubmissionsInput,
  UpdateEventApplicationSubmissionStatusInput,
  UpsertEventApplicationFormInput,
  UpsertEventApplicationQuestionInput,
  ApplicationFormDefaults,
  ApplicationSubmissionStatus,
} from "@th/ports/repos/events";
import { Prisma } from "@prisma/client";
import type {
  EventApplicationForm as PrismaEventApplicationForm,
  EventApplicationQuestion as PrismaEventApplicationQuestion,
  EventApplicationSubmission as PrismaEventApplicationSubmission,
} from "@prisma/client";

import { mintApplicationFormPublicId } from "@th/core/lib/application-form-public-id";

import { makeOpenCallMethods } from "./event-applications-open-calls";
import { makeOpenCallSubmissionMethods } from "./event-applications-open-call-submissions";
import { makeOpenCallReviewMethods } from "./event-applications-open-call-review";
import { makeOpenCallDecisionMethods } from "./event-applications-open-call-decisions";
import type { PrismaClientOrTx } from "./types";

/**
 * The two SQL-only partial unique indexes behind the one-open-application
 * rule, per FORM since open calls v1 (migration 20261005120000_open_calls
 * re-keyed them eventId -> formId). Only a P2002 on one of THESE is a
 * duplicate application; any other unique (e.g. `statusTokenHash`) is a bug
 * and must surface as itself.
 */
const OPEN_DEDUPE_INDEXES: ReadonlySet<string> = new Set([
  "EventApplicationSubmission_open_human_key",
  "EventApplicationSubmission_open_guest_key",
  // Open calls Q42: one open application per (form, organisation).
  "EventApplicationSubmission_open_org_key",
]);

/**
 * Index names a P2002 names, collected verbatim across engine shapes (same
 * probe as `uniqueViolationIndexNames` in event-invites.ts and
 * `rethrowCalendarUniqueViolation` in calendars.ts): the classic engine puts
 * a field array or raw index name on `meta.target`; driver-adapter mode
 * (Prisma 7, the only mode this repo runs) nests the cause under
 * `meta.driverAdapterError.cause`, where the index name shows up as
 * `constraint.index` or inside Postgres's `violates unique constraint
 * "<name>"` message. Exact captures only, never a substring guess.
 */
function uniqueViolationIndexNames(
  error: Prisma.PrismaClientKnownRequestError,
): string[] {
  const m = (error.meta ?? {}) as {
    target?: unknown;
    constraint?: unknown;
    driverAdapterError?: {
      cause?: { constraint?: unknown; originalMessage?: unknown };
    };
  };
  const names: string[] = [];
  const collect = (slot: unknown): void => {
    if (typeof slot === "string") {
      names.push(slot);
      const quoted = /unique constraint "([^"]+)"/.exec(slot);
      if (quoted?.[1]) names.push(quoted[1]);
    } else if (
      slot !== null &&
      typeof slot === "object" &&
      "index" in slot &&
      typeof (slot as { index: unknown }).index === "string"
    ) {
      names.push((slot as { index: string }).index);
    }
  };
  collect(m.target);
  collect(m.constraint);
  collect(m.driverAdapterError?.cause?.constraint);
  collect(m.driverAdapterError?.cause?.originalMessage);
  return names;
}

/** True only for a P2002 raised by one of {@link OPEN_DEDUPE_INDEXES}. */
function isOpenDedupeViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    uniqueViolationIndexNames(error).some((name) =>
      OPEN_DEDUPE_INDEXES.has(name),
    )
  );
}

/**
 * Narrow the nullable `eventId` columns (open calls v1: series-owned forms
 * and their submissions carry eventId NULL) to the event-owned records this
 * repo returns. Every read here is keyed by eventId or filters
 * `eventId: { not: null }`, so a null is a broken invariant, not data.
 */
function requireEventId(
  eventId: string | null,
  table: "EventApplicationForm" | "EventApplicationSubmission",
  id: string,
): string {
  if (eventId === null) {
    throw new Error(`${table} ${id} has no eventId (series-owned row)`);
  }
  return eventId;
}

/**
 * Every submission read carries its form's purpose, so core can tell an
 * attendee (ATTEND) application from an open-call (PERFORM) one when it
 * loads a row by id or by token.
 */
const SUBMISSION_INCLUDE = {
  form: { select: { purpose: true } },
} as const satisfies Prisma.EventApplicationSubmissionInclude;

type SubmissionRow = PrismaEventApplicationSubmission & {
  form: { purpose: ApplicationFormPurpose };
};

/**
 * Runtime guard for the REQUIRED purpose argument. The compiler already
 * demands it, but Prisma silently DROPS an `undefined` filter, so a caller
 * that slips past the types (a cast, a JS caller, an untyped test) would turn
 * `form: { purpose: undefined }` into "any form" and read the other form's
 * rows. Fail loudly instead.
 */
function requirePurpose(
  purpose: unknown,
  method: string,
): ApplicationFormPurpose {
  if (purpose !== "ATTEND" && purpose !== "PERFORM") {
    throw new Error(
      `eventApplications.${method}: purpose is required (ATTEND | PERFORM), got ${String(purpose)}`,
    );
  }
  return purpose;
}

/** Same guard for a REQUIRED formId (an undefined formId filter = any form). */
function requireFormId(formId: unknown, method: string): string {
  if (typeof formId !== "string" || formId.length === 0) {
    throw new Error(`eventApplications.${method}: formId is required`);
  }
  return formId;
}

/**
 * "Open" application statuses for the one-open-per-applicant rule (spec Phase
 * 3 item 2 / D5). MUST stay byte-identical to the `status IN (...)` predicate
 * of the two SQL-only partial unique indexes (migration
 * 20260811140000_application_submission_open_dedupe, re-keyed to formId by
 * 20261005120000_open_calls) — a drift here turns the
 * pre-check into a lie and surfaces as a raw P2002 instead of a typed error.
 * WITHDRAWN / REJECTED / EXPIRED are deliberately absent: those free the
 * applicant to apply again.
 */
const OPEN_APPLICATION_STATUSES = [
  "PENDING",
  "APPROVED",
  "WAITLISTED",
] as const satisfies readonly ApplicationSubmissionStatus[];

const DEFAULT_FORM_DEFAULTS: ApplicationFormDefaults = {
  includeName: false,
  includeReason: false,
  includeSocialLinks: false,
};

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;
const toNullableJson = (value: unknown): Prisma.NullableJsonNullValueInput =>
  (value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue)) as Prisma.NullableJsonNullValueInput;

const coerceDefaults = (
  value: Prisma.JsonValue | null,
): ApplicationFormDefaults => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_FORM_DEFAULTS;
  }

  const parsed = value as Partial<ApplicationFormDefaults>;
  return {
    includeName: parsed.includeName ?? DEFAULT_FORM_DEFAULTS.includeName,
    includeReason: parsed.includeReason ?? DEFAULT_FORM_DEFAULTS.includeReason,
    includeSocialLinks:
      parsed.includeSocialLinks ?? DEFAULT_FORM_DEFAULTS.includeSocialLinks,
  } satisfies ApplicationFormDefaults;
};

const coerceJsonRecord = (
  value: Prisma.JsonValue | null,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const coerceOptions = (
  value: Prisma.JsonValue | null,
): EventApplicationQuestionRecord["options"] => {
  if (!value || !Array.isArray(value)) {
    return null;
  }

  return value as unknown as EventApplicationQuestionRecord["options"];
};

const mapForm = (
  record: PrismaEventApplicationForm,
): EventApplicationFormRecord => ({
  id: record.id,
  eventId: requireEventId(record.eventId, "EventApplicationForm", record.id),
  purpose: record.purpose,
  publicId: record.publicId,
  introText: record.introText,
  defaults: coerceDefaults(record.defaults),
  opensAt: record.opensAt,
  closesAt: record.closesAt,
  maxSubmissions: record.maxSubmissions,
  autoApprove: record.autoApprove,
  updatedByHumanId: record.updatedByHumanId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const mapQuestion = (
  record: PrismaEventApplicationQuestion,
): EventApplicationQuestionRecord => ({
  id: record.id,
  formId: record.formId,
  type: record.type as EventApplicationQuestionRecord["type"],
  label: record.label,
  description: record.description,
  options: coerceOptions(record.options),
  isRequired: record.isRequired,
  order: record.order,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const coerceQuestionsSnapshot = (
  value: Prisma.JsonValue | null,
): Record<string, EventApplicationQuestionSnapshotEntry> =>
  coerceJsonRecord(value) as unknown as Record<
    string,
    EventApplicationQuestionSnapshotEntry
  >;

const mapSubmission = (
  record: SubmissionRow,
): EventApplicationSubmissionRecord => ({
  id: record.id,
  formId: record.formId,
  purpose: record.form.purpose,
  eventId: requireEventId(
    record.eventId,
    "EventApplicationSubmission",
    record.id,
  ),
  humanId: record.humanId,
  contactEmail: record.contactEmail,
  contactPhone: record.contactPhone,
  status: record.status,
  answers: coerceJsonRecord(record.answers),
  decisionReason: record.decisionReason ?? null,
  questionsSnapshot: coerceQuestionsSnapshot(record.questionsSnapshot ?? null),
  reviewerHumanId: record.reviewerHumanId,
  reviewedAt: record.reviewedAt,
  approvalToken: record.approvalToken,
  tokenExpiresAt: record.tokenExpiresAt,
  inviteId: record.inviteId ?? null,
  metadata: coerceJsonRecord(record.metadata),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export function makeEventApplicationsRepo(
  p: PrismaClientOrTx,
): EventApplicationsRepo {
  return {
    // Open calls (PERFORM forms) — see ./event-applications-open-calls.ts.
    ...makeOpenCallMethods(p),
    // Open-call applications — see ./event-applications-open-call-submissions.ts.
    ...makeOpenCallSubmissionMethods(p, { isOpenDedupeViolation }),
    // Organizer-side review: queue, votes, notes, thread — see
    // ./event-applications-open-call-review.ts.
    ...makeOpenCallReviewMethods(p),
    // Deciding: pick, not this time, drop out, lineup removal — see
    // ./event-applications-open-call-decisions.ts.
    ...makeOpenCallDecisionMethods(p),
    getForm: async (eventId: string, purpose: ApplicationFormPurpose) => {
      requirePurpose(purpose, "getForm");
      const form = await p.eventApplicationForm.findUnique({
        where: { eventId_purpose: { eventId, purpose } },
      });
      return form ? mapForm(form) : null;
    },
    ensureForm: async (input: {
      eventId: string;
      purpose: ApplicationFormPurpose;
    }) => {
      requirePurpose(input.purpose, "ensureForm");
      const where = {
        eventId_purpose: { eventId: input.eventId, purpose: input.purpose },
      };
      const existing = await p.eventApplicationForm.findUnique({ where });
      if (existing) return mapForm(existing);

      // INSERT ... ON CONFLICT DO NOTHING (createMany + skipDuplicates), not
      // upsert/create: a concurrent ensure that wins the race must not raise
      // a P2002, because inside `repos.tx()` any failed statement aborts the
      // whole Postgres transaction and the re-read below could never run.
      await p.eventApplicationForm.createMany({
        data: [
          {
            eventId: input.eventId,
            purpose: input.purpose,
            publicId: mintApplicationFormPublicId(),
            defaults: toJsonValue(DEFAULT_FORM_DEFAULTS),
          },
        ],
        skipDuplicates: true,
      });
      const record = await p.eventApplicationForm.findUnique({ where });
      if (!record) {
        // Only reachable if the insert was skipped on a publicId collision
        // (36^10 space) rather than on (eventId, purpose).
        throw new Error(
          `ensureForm: could not create ${input.purpose} form for event ${input.eventId}`,
        );
      }
      return mapForm(record);
    },
    upsertForm: async (input: UpsertEventApplicationFormInput) => {
      requirePurpose(input.purpose, "upsertForm");
      // Presence-guarded update (same hasOwnProperty discipline as
      // upsertQuestion below): the question builder and the gate-settings
      // panel each write a different slice of this row, so a field ABSENT
      // from the input must leave the stored value untouched — only an
      // explicit null clears it.
      const has = (key: keyof UpsertEventApplicationFormInput) =>
        Object.prototype.hasOwnProperty.call(input, key) &&
        input[key] !== undefined;

      // Unchecked variant: the scalar FK (`updatedByHumanId`) is what the
      // caller supplies — the CHECKED update input only accepts the
      // `updatedBy` relation and rejects the raw column.
      const update: Prisma.EventApplicationFormUncheckedUpdateInput = {
        updatedByHumanId: input.updatedByHumanId,
      };
      if (has("introText")) update.introText = input.introText ?? null;
      if (has("defaults")) update.defaults = toJsonValue(input.defaults);
      if (has("opensAt")) update.opensAt = input.opensAt ?? null;
      if (has("closesAt")) update.closesAt = input.closesAt ?? null;
      if (has("maxSubmissions")) {
        update.maxSubmissions = input.maxSubmissions ?? null;
      }
      if (has("autoApprove")) update.autoApprove = input.autoApprove;

      const record = await p.eventApplicationForm.upsert({
        where: {
          eventId_purpose: { eventId: input.eventId, purpose: input.purpose },
        },
        update,
        create: {
          eventId: input.eventId,
          purpose: input.purpose,
          publicId: mintApplicationFormPublicId(),
          introText: input.introText ?? null,
          defaults: toJsonValue(input.defaults ?? DEFAULT_FORM_DEFAULTS),
          opensAt: input.opensAt ?? null,
          closesAt: input.closesAt ?? null,
          maxSubmissions: input.maxSubmissions ?? null,
          autoApprove: input.autoApprove ?? false,
          updatedByHumanId: input.updatedByHumanId,
        },
      });

      return mapForm(record);
    },
    listQuestions: async (formId: string) => {
      const questions = await p.eventApplicationQuestion.findMany({
        where: { formId },
        orderBy: { order: "asc" },
      });

      return questions.map(mapQuestion);
    },
    upsertQuestion: async (input: UpsertEventApplicationQuestionInput) => {
      if (input.questionId) {
        const data: Prisma.EventApplicationQuestionUpdateInput = {
          type: input.type,
          label: input.label,
        };

        if (Object.prototype.hasOwnProperty.call(input, "description")) {
          data.description = input.description ?? null;
        }

        if (Object.prototype.hasOwnProperty.call(input, "options")) {
          data.options = toNullableJson(input.options ?? null);
        }

        if (Object.prototype.hasOwnProperty.call(input, "isRequired")) {
          data.isRequired = input.isRequired ?? false;
        }

        if (Object.prototype.hasOwnProperty.call(input, "order")) {
          data.order = input.order ?? 0;
        }

        const record = await p.eventApplicationQuestion.update({
          where: { id: input.questionId },
          data,
        });

        return mapQuestion(record);
      }

      const record = await p.eventApplicationQuestion.create({
        data: {
          formId: input.formId,
          type: input.type,
          label: input.label,
          description: input.description ?? null,
          options: toNullableJson(input.options ?? null),
          isRequired: input.isRequired ?? false,
          order: input.order ?? 0,
        },
      });

      return mapQuestion(record);
    },
    deleteQuestion: async (questionId: string) => {
      await p.eventApplicationQuestion.delete({ where: { id: questionId } });
    },
    createSubmission: async (input: CreateEventApplicationSubmissionInput) => {
      try {
        const record = await p.eventApplicationSubmission.create({
          include: SUBMISSION_INCLUDE,
          data: {
            formId: requireFormId(input.formId, "createSubmission"),
            eventId: input.eventId,
            humanId: input.humanId ?? null,
            contactEmail: input.contactEmail ?? null,
            contactPhone: input.contactPhone ?? null,
            answers: toJsonValue(input.answers),
            questionsSnapshot: toJsonValue(input.questionsSnapshot ?? {}),
            inviteId: input.inviteId ?? null,
            metadata: toJsonValue({}),
            createdAt: input.submittedAt,
            updatedAt: input.submittedAt,
          },
        });

        return mapSubmission(record);
      } catch (error) {
        // Map ONLY a P2002 from the SQL-only partial unique indexes
        // "EventApplicationSubmission_open_human_key" (one open application
        // per form × human) or "..._open_guest_key" (one open application per
        // form × lower(email)) — see application.prisma — to the same domain
        // error as the use-case pre-check. Matched by index NAME: the table
        // also has unique `approvalToken` and `statusTokenHash` columns, and a
        // collision on either is a bug, not a duplicate application.
        if (isOpenDedupeViolation(error)) {
          throw {
            code: "duplicate_open_application",
            message: "duplicate_open_application",
            cause: error,
          } as const;
        }
        throw error;
      }
    },
    updateSubmissionStatus: async (
      input: UpdateEventApplicationSubmissionStatusInput,
    ) => {
      const data = {
        status: input.status,
        ...(Object.prototype.hasOwnProperty.call(input, "reviewerHumanId")
          ? { reviewerHumanId: input.reviewerHumanId ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "reviewedAt")
          ? { reviewedAt: input.reviewedAt ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "approvalToken")
          ? { approvalToken: input.approvalToken ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "tokenExpiresAt")
          ? { tokenExpiresAt: input.tokenExpiresAt ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "decisionReason")
          ? { decisionReason: input.decisionReason ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, "inviteId")
          ? { inviteId: input.inviteId ?? null }
          : {}),
      };

      // Guarded compare-and-swap (mirrors bookingRequests.updateStatus):
      // the WHERE re-checks the current status inside the write, so a
      // concurrent transition committed after the caller's read surfaces as
      // a conflict instead of being clobbered.
      //
      // P2002 mapping, symmetric with `createSubmission`: this is ALSO a
      // write that moves rows INTO the open set (PENDING | APPROVED |
      // WAITLISTED), so it can violate the same two partial unique indexes.
      // The real flow: a guest applies -> the window closes -> the sweep
      // marks the row EXPIRED -> the guest legitimately re-applies -> the
      // organizer now approves the OLD row, which would put TWO open rows on
      // (formId, lower(contactEmail)). Same shape when rescinding a REJECTED
      // decision the applicant has already re-applied past. Unmapped, that
      // P2002 escapes as INTERNAL_SERVER_ERROR and rolls back the whole
      // review/rescind transaction.
      try {
        const guardsInvite = Object.prototype.hasOwnProperty.call(
          input,
          "expectedInviteId",
        );
        if (input.expectedFromStatuses?.length || guardsInvite) {
          const result = await p.eventApplicationSubmission.updateMany({
            where: {
              id: input.submissionId,
              ...(input.expectedFromStatuses?.length
                ? { status: { in: input.expectedFromStatuses } }
                : {}),
              // Same statement as the status check: an approval re-stamped
              // under another invite after the caller's read misses here.
              ...(guardsInvite
                ? { inviteId: input.expectedInviteId ?? null }
                : {}),
            },
            data,
          });
          if (result.count === 0) {
            // Bare object literal, not an Error: this is the established
            // `{ code, message }` use-case-error shape the transport's
            // `toUseCaseError` path understands, and it mirrors
            // bookingRequests.updateStatus byte-for-byte. Every caller catches
            // it via `isStatusConflict` and maps it to INVALID_STATUS, so it
            // never escapes to Sentry as a "Non-Error exception"; upgrading it
            // to an Error subclass is a repo-wide change to make in one pass
            // with the booking-request twin, not here.
            throw {
              code: "conflict",
              message: "application_submission_status_changed",
            } as const;
          }
          // updateMany can't return the row — re-read it.
          const record = await p.eventApplicationSubmission.findUniqueOrThrow({
            where: { id: input.submissionId },
            include: SUBMISSION_INCLUDE,
          });
          return mapSubmission(record);
        }

        const record = await p.eventApplicationSubmission.update({
          where: { id: input.submissionId },
          data,
          include: SUBMISSION_INCLUDE,
        });

        return mapSubmission(record);
      } catch (error) {
        // Same index-name match as createSubmission: an `approvalToken`
        // collision is not a duplicate application.
        if (isOpenDedupeViolation(error)) {
          throw {
            code: "duplicate_open_application",
            message: "duplicate_open_application",
            cause: error,
          } as const;
        }
        // The `conflict` sentinel above and every other failure pass through
        // untouched — only the dedupe violation is reinterpreted.
        throw error;
      }
    },
    listSubmissions: async (input: ListApplicationSubmissionsInput) => {
      const { limit, offset } = sanitizeOffsetPagination({
        limit: input.limit,
        offset: input.offset,
        defaultLimit: 50,
        maxLimit: 200,
      });

      // `form.purpose` names WHICH of the event's forms: the composite FK
      // pins submission.eventId = form.eventId, so (eventId, purpose) is
      // exactly one form.
      const where = {
        eventId: input.eventId,
        form: { purpose: requirePurpose(input.purpose, "listSubmissions") },
        ...(input.statuses?.length
          ? {
              status: {
                in: input.statuses,
              },
            }
          : {}),
        ...(input.inviteId ? { inviteId: input.inviteId } : {}),
      } satisfies Prisma.EventApplicationSubmissionWhereInput;

      const [total, submissions] = await Promise.all([
        p.eventApplicationSubmission.count({ where }),
        p.eventApplicationSubmission.findMany({
          where,
          include: SUBMISSION_INCLUDE,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
        }),
      ]);

      return {
        items: submissions.map(mapSubmission),
        pageInfo: buildOffsetPageInfo({
          total,
          limit,
          offset,
          count: submissions.length,
        }),
      };
    },
    countSubmissions: async (input: CountApplicationSubmissionsInput) => {
      return p.eventApplicationSubmission.count({
        where: {
          eventId: input.eventId,
          form: { purpose: requirePurpose(input.purpose, "countSubmissions") },
          ...(input.statuses?.length ? { status: { in: input.statuses } } : {}),
          // R11: invite approvals don't count against maxSubmissions.
          ...(input.excludeInvited ? { inviteId: null } : {}),
        },
      });
    },
    expireSubmissionsForClosedForms: async (input: {
      cutoff: Date;
      purpose: "ATTEND";
    }) => {
      // Read-then-guarded-write (as the booking-request sweep did before P2d-2):
      // collect the candidate ids first so the batch audit row can name
      // them, then re-check status PENDING inside the update so a
      // concurrent review/withdraw between read and write is never
      // clobbered. Strict `lt`: a form whose closesAt is exactly at the
      // cutoff is not yet "past closesAt + grace".
      //
      // Through the submission's OWN form, restricted to ATTEND: an open call
      // (PERFORM) never auto-closes at its deadline (open calls Q12/FR-004),
      // so its PENDING applications must survive past closesAt.
      const due = await p.eventApplicationSubmission.findMany({
        where: {
          status: "PENDING",
          form: {
            // The type admits only ATTEND; the guard stops a cast from
            // dropping the filter and sweeping open calls too.
            purpose: requirePurpose(
              input.purpose,
              "expireSubmissionsForClosedForms",
            ),
            closesAt: { lt: input.cutoff },
          },
        },
        select: { id: true },
      });
      if (due.length === 0) return { count: 0, ids: [] };

      const ids = due.map((row) => row.id);
      const result = await p.eventApplicationSubmission.updateMany({
        where: { id: { in: ids }, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      // `ids` are the PRE-READ candidates and may overstate when a
      // concurrent review wins the guarded write; `count` is authoritative.
      return { count: result.count, ids };
    },
    getSubmissionById: async (submissionId: string) => {
      // Event-owned rows only (see the port): a series-call submission has
      // eventId NULL and reads as missing.
      const record = await p.eventApplicationSubmission.findUnique({
        where: { id: submissionId, eventId: { not: null } },
        include: SUBMISSION_INCLUDE,
      });
      return record ? mapSubmission(record) : null;
    },
    getSubmissionByToken: async (token: string) => {
      const record = await p.eventApplicationSubmission.findUnique({
        where: { approvalToken: token, eventId: { not: null } },
        include: SUBMISSION_INCLUDE,
      });
      return record ? mapSubmission(record) : null;
    },
    getSubmissionByEventAndHuman: async (
      eventId: string,
      purpose: ApplicationFormPurpose,
      humanId: string,
    ) => {
      const record = await p.eventApplicationSubmission.findFirst({
        where: {
          eventId,
          form: {
            purpose: requirePurpose(purpose, "getSubmissionByEventAndHuman"),
          },
          humanId,
        },
        include: SUBMISSION_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      return record ? mapSubmission(record) : null;
    },
    findOpenSubmission: async (input: FindOpenApplicationSubmissionInput) => {
      // Identity is EXCLUSIVE by construction (the port's union type), and the
      // where clause pins the other side explicitly so a guest lookup can
      // never match a signed-in row and vice-versa — mirroring the two
      // partial unique indexes' predicates exactly.
      const identity =
        input.humanId !== undefined
          ? // applyingAsOrgId null mirrors the open_human_key predicate
            // (owner ruling Q42: org rows dedupe on the org). Attendee rows
            // never set it, so this changes nothing for the gate.
            { humanId: input.humanId, applyingAsOrgId: null }
          : // Emails are lowercased at rest (submit-event-application +
            // migration 20260811140000), so plain equality agrees with the
            // index's lower(contactEmail) expression. Lowercase defensively
            // in case a caller passes a raw address.
            {
              humanId: null,
              contactEmail: (input.contactEmail as string).toLowerCase(),
            };

      // Keyed by formId, exactly like the partial unique indexes.
      const record = await p.eventApplicationSubmission.findFirst({
        where: {
          formId: requireFormId(input.formId, "findOpenSubmission"),
          ...identity,
          status: { in: [...OPEN_APPLICATION_STATUSES] },
        },
        include: SUBMISSION_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      return record ? mapSubmission(record) : null;
    },
    attachSubmissionToHuman: async (input: {
      submissionId: string;
      humanId: string;
    }) => {
      try {
        // Compare-and-swap on `humanId IS NULL`: a submission already bound
        // to someone (including a concurrent redeem of the same link) must
        // never be re-pointed. `updateMany` is what lets the null-check ride
        // inside the write.
        const result = await p.eventApplicationSubmission.updateMany({
          where: { id: input.submissionId, humanId: null },
          data: { humanId: input.humanId },
        });
        if (result.count === 0) {
          return null;
        }
        const record = await p.eventApplicationSubmission.findUnique({
          where: { id: input.submissionId, eventId: { not: null } },
          include: SUBMISSION_INCLUDE,
        });
        return record ? mapSubmission(record) : null;
      } catch (error) {
        // The redeemer already has an open application on this form, so the
        // attach would violate "EventApplicationSubmission_open_human_key".
        // Attaching is best-effort garnish on the redemption — swallow to
        // `null` rather than failing the unlock the applicant came for.
        if (isOpenDedupeViolation(error)) {
          return null;
        }
        throw error;
      }
    },
    lockApprovedSubmission: async (input: {
      submissionId: string;
      eventId: string;
      purpose: ApplicationFormPurpose;
      reviewedAt: Date;
    }) => {
      // A guarded no-op UPDATE rather than `SELECT … FOR UPDATE`: the WHERE
      // re-checks the approval instance inside the write, and the write takes
      // the row lock until the caller's transaction ends. Under READ
      // COMMITTED a concurrent rescind already holding the lock makes this
      // wait, then re-evaluate the WHERE against the committed PENDING row and
      // match nothing. It rewrites `reviewedAt` with the value it already
      // has; Prisma also bumps `updatedAt`, which is the only visible change.
      //
      // The form is resolved to its id first so the UPDATE's WHERE stays
      // scalar-only (a relation filter in updateMany is not guaranteed to
      // stay inside the single locking statement). purpose is immutable, so
      // reading it outside the lock is safe.
      requirePurpose(input.purpose, "lockApprovedSubmission");
      const form = await p.eventApplicationForm.findUnique({
        where: {
          eventId_purpose: { eventId: input.eventId, purpose: input.purpose },
        },
        select: { id: true },
      });
      if (!form) return false;
      const result = await p.eventApplicationSubmission.updateMany({
        where: {
          id: input.submissionId,
          eventId: input.eventId,
          formId: form.id,
          status: "APPROVED",
          reviewedAt: input.reviewedAt,
        },
        data: { reviewedAt: input.reviewedAt },
      });
      return result.count > 0;
    },
  } satisfies EventApplicationsRepo;
}
