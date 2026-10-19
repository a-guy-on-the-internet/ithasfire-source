import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "../events/_shared/ensure-actor-can-edit-event";
import { normalizeQuestionOptions } from "../events/_shared/question-options";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import {
  anchorOfForm,
  ensureActorCanEditOpenCallAnchor,
} from "../events/open-calls/_shared/open-call-anchor";
import {
  applyApplicationFormTemplateInputSchema,
  applyApplicationFormTemplateResultSchema,
  applyApplicationFormTemplateToOpenCallInputSchema,
  type ApplyApplicationFormTemplateInput,
  type ApplyApplicationFormTemplateResult,
  type ApplyApplicationFormTemplateToOpenCallInput,
} from "./schemas";
import type { ApplicationFormTemplateRecord } from "@th/types";
import type { TxRepos } from "@th/ports/repos";

const IDEMPOTENCY_TTL_SECONDS = 120;

const CHOICE_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);

/**
 * Statuses that count as "somebody is still mid-flight". ONLY these block.
 *
 * The guard exists for one situation: an applicant whose application is still
 * being decided, whose answers the organizer is about to read next to a form
 * that changed underneath them. That is PENDING and WAITLISTED, and nothing
 * else.
 *
 * DELIBERATELY NOT BLOCKING:
 *   - REJECTED / APPROVED — the decision is made. An organizer who ran an open
 *     call, decided all twelve applicants, and reopened for round two would
 *     otherwise be permanently barred from ever applying a template to that
 *     event, told to "edit the questions directly" — while
 *     `upsertEventApplicationQuestion`, which can rewrite or delete a live
 *     question, has no such guard at all. That is a strictly harsher rule on
 *     the strictly safer operation.
 *   - WITHDRAWN / EXPIRED — the applicant left or the sweep closed them out;
 *     same reasoning as the cap check in submit-event-application.
 *
 * Two properties make the narrow set safe, and BOTH must hold — see the note
 * on the count/write window below before touching either:
 *   1. this apply is APPEND-ONLY (no existing question is edited or deleted);
 *   2. every submission carries its own `questionsSnapshot` (spec D3), so a
 *      decided application renders from the form as it was at submit time and
 *      cannot be orphaned by anything appended afterwards.
 */
const BLOCKING_SUBMISSION_STATUSES = ["PENDING", "WAITLISTED"] as const;

export type ApplyApplicationFormTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredApplyResult {
  payloadHash: string;
  response: ApplyApplicationFormTemplateResult;
}

function buildPayloadHash(
  input: ApplyApplicationFormTemplateInput | ApplyApplicationFormTemplateToOpenCallInput,
): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * FORK-ON-USE (spec D4). Copies a template's `introText` onto the event's
 * `EventApplicationForm` and its `questions` snapshot into real
 * `EventApplicationQuestion` ROWS. No live link is created — editing the
 * template afterwards never touches this event.
 *
 * ── Authorization (BOTH checks, because this is event-scoped AND
 *    template-scoped) ─────────────────────────────────────────────────────
 *
 *   1. TEMPLATE: a platform catalogue row is readable by any authenticated
 *      actor; an OWNED row goes through `ensureTemplateOwnerAccess(view)`.
 *   2. EVENT: `ensureActorCanEditEvent` — org membership in ORG_EDIT_ROLES,
 *      or personal ownership. Community listings are refused there.
 *
 * Neither check subsumes the other: an org admin may not read another org's
 * template, and a template's owner may not write to someone else's event.
 *
 * ── Refusal ────────────────────────────────────────────────────────────────
 *
 * REFUSES with APPLICATION_SUBMISSIONS_EXIST if the event already has a
 * non-withdrawn/non-expired submission. Applying appends questions, and the
 * live answers of an in-flight applicant are keyed by question id; reshaping
 * the form under them is the exact orphaning defect `questionsSnapshot`
 * (spec D3) exists to contain. Refusing is cheaper than reasoning about it.
 *
 * ── Append, not replace ────────────────────────────────────────────────────
 *
 * Existing questions are KEPT and the template's are appended after them.
 * Destroying an organizer's hand-written questions because they clicked
 * "start from a template" is not a recoverable mistake; adding rows they can
 * delete is.
 */
export async function applyApplicationFormTemplate(
  deps: ApplyApplicationFormTemplateDeps,
  rawInput: unknown,
): Promise<ApplyApplicationFormTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "applyApplicationFormTemplate",
  });

  const execute = async () => {
    const input = parseInput(applyApplicationFormTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `application-form-template:apply:${input.eventId}:${input.clientKey}`;

    const replay = await deps.idempotency.get<StoredApplyResult>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredApplyResult>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      // ONE transaction: guards, form upsert and every question row land
      // together, so a mid-apply failure can never leave a half-forked form.
      const result = await deps.repos.tx(async (tx) => {
        // ── 1. Template guard ────────────────────────────────────────────
        const template = await loadReadableTemplate(tx, input, scopedLogger);
        // This applies onto the event's ATTEND form. A PERFORM template (the
        // seeded performer application) is still accepted and its questions
        // copied as before, so open calls step 2 stays behaviour-neutral.
        // TODO(open-calls step 11): narrow to ATTEND once the open-call builder has its own picker

        // ── 2. Event guard ───────────────────────────────────────────────
        const event = await ensureActorCanEditEvent(
          tx,
          input.eventId,
          input.actorHumanId,
        );
        if (event.gateType !== "APPLICATION") {
          throw fail("EVENT_NOT_APPLICATION_GATED");
        }

        // ── 3. Refuse while anyone is mid-flight ─────────────────────────
        //
        // TOCTOU, and BENIGN BY CONSTRUCTION: a submission can land between
        // this count and the writes below (they share one transaction, but a
        // concurrent submit is its own transaction and may commit in the
        // window). That applicant is unharmed for exactly two reasons —
        // this apply only APPENDS, so no question they answered is edited or
        // deleted; and their submission captured its own `questionsSnapshot`
        // at submit time (spec D3), so the review queue renders their answers
        // against the form they actually saw.
        //
        // IF YOU EVER MAKE APPLY REPLACE OR EDIT EXISTING QUESTIONS, this
        // window stops being benign and needs real serialization (a row lock
        // on the form, or a post-write re-count that aborts). Do not "tidy"
        // the append-only behaviour without revisiting it.
        const submissionCount = await tx.eventApplications.countSubmissions({
          eventId: event.id,
          // The attendee builder applies templates to the ATTEND form only.
          purpose: "ATTEND",
          statuses: [...BLOCKING_SUBMISSION_STATUSES],
        });
        if (submissionCount > 0) {
          throw fail("APPLICATION_SUBMISSIONS_EXIST", {
            meta: { eventId: event.id, submissionCount },
          });
        }

        // ── 4. Fork the intro ────────────────────────────────────────────
        // `introText` is written ONLY when the template carries one, so
        // applying a question-only template can't blank an intro the
        // organizer already wrote (presence semantics of upsertForm: an
        // absent key leaves the stored value alone).
        const form = await tx.eventApplications.upsertForm({
          eventId: event.id,
          purpose: "ATTEND",
          updatedByHumanId: input.actorHumanId,
          ...(template.introText !== null
            ? { introText: template.introText }
            : {}),
        });

        // ── 5. Fork the questions into rows ──────────────────────────────
        const { createdQuestionIds, created } = await forkTemplateQuestions(
          tx,
          form.id,
          template,
        );

        const now = deps.clock.now();
        await tx.audit.log({
          entity: "event",
          entityId: event.id,
          action: "application_form_template_applied",
          data: {
            actorHumanId: input.actorHumanId,
            templateId: template.id,
            isPlatform: template.isPlatform,
            formId: form.id,
            createdQuestionIds,
          },
          at: now,
        });

        return applyApplicationFormTemplateResultSchema.parse({
          formId: form.id,
          createdQuestionIds,
          created,
        });
      });

      await deps.idempotency.commit<StoredApplyResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("apply_application_form_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("applyApplicationFormTemplate", execute);
  }

  return execute();
}

/**
 * The template, if this actor may read it: a platform catalogue row is
 * readable by any authenticated actor, an OWNED row goes through
 * `ensureTemplateOwnerAccess(view)`. Archived rows refuse.
 */
async function loadReadableTemplate(
  tx: TxRepos,
  input: { templateId: string; actorHumanId: string },
  logger: LoggerPort | undefined,
): Promise<ApplicationFormTemplateRecord> {
  const template = await tx.applicationFormTemplates.getById(input.templateId);
  if (!template) {
    throw fail("TEMPLATE_NOT_FOUND");
  }
  if (template.archivedAt) {
    throw fail("TEMPLATE_ARCHIVED");
  }
  if (template.isPlatform || template.ownerId === null) {
    // A catalogue row is readable by anyone; a MIS-SHAPED row (flag set
    // WITH an ownerId, or ownerId null WITHOUT the flag) has no
    // coherent tenancy and fails CLOSED rather than open.
    if (!template.isPlatform || template.ownerId !== null) {
      throw fail("TEMPLATE_NOT_FOUND");
    }
  } else {
    await ensureTemplateOwnerAccess(
      tx,
      template.ownerScope,
      template.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      logger,
    );
  }
  return template;
}

/** Append the template's questions to the form as real rows (fork-on-use). */
async function forkTemplateQuestions(
  tx: TxRepos,
  formId: string,
  template: ApplicationFormTemplateRecord,
): Promise<{ createdQuestionIds: string[]; created: string[] }> {
  const existing = await tx.eventApplications.listQuestions(formId);
  // Append AFTER whatever is already there — see the doc comment.
  let nextOrder = existing.reduce(
    (max, question) => Math.max(max, question.order + 1),
    0,
  );

  const createdQuestionIds: string[] = [];
  const created: string[] = [];

  for (const question of template.questions) {
    // Every stored shape (bare strings, builder `{value}`, canonical
    // `{id,label}`) converges on canonical through the SHARED helper —
    // the one the question write path and the submit-time snapshot use.
    // Without it a seeded/legacy template forks options the gate cannot
    // render.
    const options = normalizeQuestionOptions(question.options);
    const isChoice = CHOICE_TYPES.has(question.type);
    if (isChoice && options.length === 0) {
      // The write-time schema already refuses this; a hand-edited or
      // legacy row could still reach here, and a choice question with
      // no options is the Phase-1 dead-end all over again.
      throw fail("OPTIONS_REQUIRED", {
        meta: { templateId: template.id, label: question.label },
      });
    }

    const row = await tx.eventApplications.upsertQuestion({
      formId,
      type: question.type,
      label: question.label,
      description: question.description ?? null,
      options: isChoice ? options : null,
      isRequired: question.isRequired,
      order: nextOrder,
    });
    nextOrder += 1;
    createdQuestionIds.push(row.id);
    created.push(row.label);
  }

  return { createdQuestionIds, created };
}

/**
 * FORK-ON-USE onto an OPEN CALL (open calls v1, FR-001): same as
 * {@link applyApplicationFormTemplate}, but the target is an existing PERFORM
 * form, named by its id, on an event OR a series.
 *
 *   - Template: only a PERFORM template (templates never cross over between
 *     builders); any other purpose answers TEMPLATE_NOT_FOUND, as the
 *     open-call picker never lists it.
 *   - Target: the call must exist (OPEN_CALL_NOT_FOUND otherwise): a call's
 *     pay is required and a template carries none, so the builder posts the
 *     call first. Auth: edit rights on the call's event or series. No
 *     attendee gate is needed.
 *   - Same refusal while anyone is mid-flight (PENDING / WAITLISTED), same
 *     append-only fork, same idempotency discipline.
 */
export async function applyApplicationFormTemplateToOpenCall(
  deps: ApplyApplicationFormTemplateDeps,
  rawInput: unknown,
): Promise<ApplyApplicationFormTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "applyApplicationFormTemplateToOpenCall",
  });

  const execute = async () => {
    const input = parseInput(
      applyApplicationFormTemplateToOpenCallInputSchema,
      rawInput,
    );
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `application-form-template:apply-open-call:${input.formId}:${input.clientKey}`;

    const replay = await deps.idempotency.get<StoredApplyResult>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredApplyResult>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await deps.repos.tx(async (tx) => {
        const template = await loadReadableTemplate(tx, input, scopedLogger);
        if (template.purpose !== "PERFORM") {
          throw fail("TEMPLATE_NOT_FOUND", {
            meta: { reason: "purpose_mismatch" },
          });
        }

        const call = await tx.eventApplications.getOpenCallById(input.formId);
        if (!call) {
          throw fail("OPEN_CALL_NOT_FOUND");
        }
        await ensureActorCanEditOpenCallAnchor(
          tx,
          call,
          input.actorHumanId,
          scopedLogger,
        );

        // Same benign-by-construction TOCTOU as the attendee apply above:
        // append-only, and every submission carries its own snapshot.
        const submissionCount = await tx.eventApplications.countSubmissionsByForm({
          formId: call.id,
          statuses: [...BLOCKING_SUBMISSION_STATUSES],
        });
        if (submissionCount > 0) {
          throw fail("APPLICATION_SUBMISSIONS_EXIST", {
            meta: { formId: call.id, submissionCount },
          });
        }

        const anchor = anchorOfForm(call);
        if (template.introText !== null) {
          await tx.eventApplications.upsertOpenCall({
            anchor,
            updatedByHumanId: input.actorHumanId,
            introText: template.introText,
          });
        }

        const { createdQuestionIds, created } = await forkTemplateQuestions(
          tx,
          call.id,
          template,
        );

        await tx.audit.log({
          entity: anchor.kind === "event" ? "event" : "event_series",
          entityId: anchor.kind === "event" ? anchor.eventId : anchor.seriesId,
          action: "application_form_template_applied",
          data: {
            actorHumanId: input.actorHumanId,
            templateId: template.id,
            isPlatform: template.isPlatform,
            formId: call.id,
            createdQuestionIds,
          },
          at: deps.clock.now(),
        });

        return applyApplicationFormTemplateResultSchema.parse({
          formId: call.id,
          createdQuestionIds,
          created,
        });
      });

      await deps.idempotency.commit<StoredApplyResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("apply_application_form_template_to_open_call", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("applyApplicationFormTemplateToOpenCall", execute);
  }

  return execute();
}
