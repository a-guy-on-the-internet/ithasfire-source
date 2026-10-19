import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  ImageModerationRecord,
  ImageModerationSubjectType,
  ImageModerationStatus,
} from "@th/ports/repos/image-moderation-records";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { IMAGE_MODERATION_REJECT_DELETION_SOURCE } from "./_shared/moderation-deletion-source";
import type { NotifyInput } from "../comms/notify";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  normalizeAppBaseUrl,
  resolveImageModerationSubject,
} from "./image-moderation-subject";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const reviewFlaggedImageInputSchema = z
  .object({
    /**
     * The already-authorized moderator. AUTHZ IS ENFORCED AT THE TRANSPORT
     * LAYER (Step 4) via the community-moderation gate (COMMUNITY_MODERATION_
     * ROLES / platform ADMIN, 2FA-enforced like the rest of /moderate). This use
     * case accepts the authorized actor and records it on the decision; it does
     * NOT re-run role checks (there is no core-level platform-staff authz method
     * — hasStaffRole lives on AuthZPort and is called from transports).
     */
    actorHumanId: z.string().uuid(),
    recordId: z.string().uuid(),
    decision: z.enum(["APPROVE", "REJECT"]),
    note: plainTextMultilineOptional(1000).optional(),
  })
  .strict();

export type ReviewFlaggedImageInput = z.infer<
  typeof reviewFlaggedImageInputSchema
>;

export const reviewFlaggedImageOutputSchema = z
  .object({
    /**
     * The record's status AFTER this call. On a genuine transition this is the
     * actor's decision (APPROVED/REJECTED). On a lost cross-decision race
     * (`alreadyDecided`) this is the record's ACTUAL current status — which may
     * differ from the attempted decision — so the transport/UI never tells the
     * moderator "REJECTED" while the image is in fact live/APPROVED.
     *
     * Carries the FULL `ImageModerationStatus` union so it stays assignable as
     * the union grows. ORPHANED is unreachable in practice on both paths — the
     * early return only fires for APPROVED/REJECTED, and the lost-CAS re-read
     * starts from a FLAGGED row that `markOrphaned` (PENDING-scoped) cannot
     * touch — but a status this schema cannot express would be a runtime output
     * parse failure, which is the wrong way to learn about a new state.
     */
    status: z.enum([
      "PENDING",
      "APPROVED",
      "FLAGGED",
      "REJECTED",
      "ORPHANED",
    ]),
    /**
     * True when a peer moderator had already decided the record before this call
     * (the FLAGGED compare-and-set affected 0 rows). The transport/UI can
     * surface "already reviewed by someone else" and reflect `status`.
     */
    alreadyDecided: z.boolean(),
  })
  .strict();

export type ReviewFlaggedImageOutput = z.infer<
  typeof reviewFlaggedImageOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewFlaggedImageDeps = {
  // Full `Repos` (not a Pick): a post-decision reindex removes/upserts the
  // image's subject doc, and `reindexAfterMutation` → `buildSearchIndex` needs
  // the event/human/place/org repos. The composition root already passes full
  // `ctx.repos`, so this is not a wiring cost.
  repos: Repos;
  notify?: (input: NotifyInput) => Promise<unknown>;
  clock: ClockPort;
  logger: LoggerPort;
  /**
   * Public web origin, used to build the absolute event link carried in the
   * uploader's approve/reject notice. Absent → the notice still names the event
   * (when resolvable) but carries no link.
   */
  appBaseUrl?: string | null;
  /**
   * Optional search port. When provided, the image's SUBJECT (event/place/
   * human/org) is reindexed after BOTH decisions so a newly-APPROVED hero
   * appears on public surfaces promptly (via read-time gating) and a REJECT
   * (or any future takedown) propagates the drop. Best-effort: never blocks the
   * decision. Absent → the nightly full reindex reconciles.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort Sentry reporting for the notify-failure swallow below AND the
   * fire-and-forget reindex swallow. Wired at the composition root (Step 5);
   * guarded so a throwing reporter never changes behaviour (CLAUDE.md error
   * convention).
   */
  reportError?: ReporterPort;
};

/**
 * Map a moderation record's subject to the search reindex selector kind. Returns
 * null when the subject can't be resolved (no subjectType/subjectId, or a
 * subjectType with no search index) so the caller skips the reindex gracefully.
 */
function reindexSelectorForSubject(
  subjectType: ImageModerationSubjectType | null,
  subjectId: string | null,
): { kind: "event" | "human" | "place" | "organization"; id: string } | null {
  if (!subjectId || !subjectType) return null;
  switch (subjectType) {
    case "EVENT":
      return { kind: "event", id: subjectId };
    case "HUMAN":
      return { kind: "human", id: subjectId };
    case "PLACE":
      return { kind: "place", id: subjectId };
    case "ORGANIZATION":
      return { kind: "organization", id: subjectId };
    default:
      return null;
  }
}

const APPROVED_VARIANT = "image.moderation.approved" as const;
const REJECTED_VARIANT = "image.moderation.rejected" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies a moderator APPROVE / REJECT decision to a FLAGGED moderation record
 * (FR-007). Idempotent: `review` is a compare-and-set on `status = "FLAGGED"`,
 * so re-reviewing an already-decided record is a no-op (0 rows) — no duplicate
 * audit row, deletion, or notification.
 *
 *   - APPROVE → status APPROVED. The image becomes visible purely via read-time
 *     gating (for EVENT_HERO no separate promote step is needed — the gate just
 *     passes). Fires the approve-after-hold notification (FR-009): only a real
 *     FLAGGED→APPROVED human review notifies; auto-approve by the worker never
 *     reaches this use case.
 *   - REJECT → status REJECTED + enqueue the R2 object for deletion via the
 *     existing pending_object_deletions outbox (in the SAME tx as the review +
 *     audit). Fires the reject notification.
 *
 * The review + deletion-enqueue + audit commit atomically in one `repos.tx`;
 * notifications fire AFTER commit (best-effort — a notify failure never fails
 * the decision).
 */
export async function reviewFlaggedImage(
  deps: ReviewFlaggedImageDeps,
  rawInput: unknown,
): Promise<ReviewFlaggedImageOutput> {
  const { repos, clock, logger } = deps;
  const input = parseInput(reviewFlaggedImageInputSchema, rawInput);
  const note = input.note ?? null;
  const targetStatus = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";

  type TxResult = {
    transitioned: boolean;
    record: ImageModerationRecord;
    actualStatus: ImageModerationStatus;
  };

  const { transitioned, record, actualStatus } = await repos.tx(
    async (tx): Promise<TxResult> => {
      const now = clock.now();

      const current = await tx.imageModerationRecords.getById(input.recordId);
      if (!current) {
        throw fail("NOT_FOUND", {
          meta: { entity: "image_moderation_record" },
        });
      }
      // STATE MACHINE: APPROVED and REJECTED are TERMINAL. There is no transition
      // out of them today — an APPROVED image stays live, a REJECTED one stays
      // deleted. IF a future change ever re-flags an already-live (APPROVED) image
      // (e.g. a takedown of previously-approved content), it MUST also wire a
      // search reindex/removal of the subject here (see the post-commit reindex
      // below), or the hidden image would linger on public surfaces until the
      // nightly full reindex — the exact drift this use case now closes.
      //
      // A peer moderator may have already decided this record before our read.
      // Treat that gracefully as an already-decided no-op (mirrors the lost-CAS
      // race path below) — the moderator sees "already reviewed", not an error.
      // Do NOT enqueue deletion, notify, or audit a new decision here.
      if (current.status === "APPROVED" || current.status === "REJECTED") {
        return {
          transitioned: false,
          record: current,
          actualStatus: current.status,
        };
      }
      // A PENDING record is not yet in the moderator queue (not flagged) — it is
      // genuinely not reviewable here, so reject the action with a precondition
      // error. Only FLAGGED records proceed to the compare-and-set below.
      if (current.status !== "FLAGGED") {
        throw fail("INVALID_STATUS", {
          meta: { recordId: current.id, status: current.status },
        });
      }

      // Compare-and-set on FLAGGED. n === 1 → a genuine FLAGGED→decision
      // transition; n === 0 → a peer moderator already decided it (idempotent
      // no-op — fire nothing).
      const n = await tx.imageModerationRecords.review({
        id: input.recordId,
        status: targetStatus,
        reviewedByHumanId: input.actorHumanId,
        reviewedAt: now,
        reviewNote: note ?? undefined,
      });

      if (n !== 1) {
        // Lost a cross-decision race (e.g. this call REJECTs while a peer already
        // APPROVEd). Re-read the row and report its ACTUAL status, NOT the
        // attempted decision, so the moderator isn't told "REJECTED" while the
        // image is in fact live/APPROVED.
        const reread = await tx.imageModerationRecords.getById(input.recordId);
        return {
          transitioned: false,
          record: current,
          actualStatus: reread?.status ?? current.status,
        };
      }

      if (input.decision === "REJECT") {
        // Enqueue the R2 object for deletion in THIS tx (existing outbox).
        await tx.pendingObjectDeletions.enqueueMany([
          {
            targetKey: current.storageKey,
            targetKind: "KEY",
            source: IMAGE_MODERATION_REJECT_DELETION_SOURCE,
            sourceId: current.id,
          },
        ]);
      }

      await tx.audit.log({
        entity: "image_moderation_record",
        entityId: current.id,
        action: "image_moderation.reviewed",
        data: {
          actorHumanId: input.actorHumanId,
          decision: input.decision,
          status: targetStatus,
          kind: current.kind,
          subjectType: current.subjectType,
          subjectId: current.subjectId,
          storageKey: current.storageKey,
          reviewNote: note,
        },
        at: now,
      });

      // The subject's document resolves its image at index time.
      const subject = reindexSelectorForSubject(
        current.subjectType,
        current.subjectId,
      );
      if (subject) await markForSearchReindex(tx, [subject], now);

      return {
        transitioned: true,
        record: current,
        actualStatus: targetStatus,
      };
    },
  );

  if (!transitioned) {
    logger.info("moderation.reviewFlaggedImage.already_decided", {
      recordId: record.id,
      decision: input.decision,
      actualStatus,
    });
    return { status: actualStatus, alreadyDecided: true };
  }

  // Reindex the image's SUBJECT after BOTH decisions (best-effort, fire-and-
  // forget). APPROVE: a newly-visible hero should show on public search/embeds
  // promptly (visibility is read-time gated, so an event upsert now re-resolves
  // the hero). REJECT: the drop propagates the same way. `reindexAfterMutation`
  // resolves the correct entity kind from the subject; an unresolvable subject
  // is skipped gracefully. reportError is threaded so a dropped update is
  // Sentry-visible, not a silent warn.
  const reindexSelector = reindexSelectorForSubject(
    record.subjectType,
    record.subjectId,
  );
  if (reindexSelector) {
    reindexAfterMutation(
      {
        repos: deps.repos,
        search: deps.search,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      "reviewFlaggedImage",
      reindexSelector,
    );
  } else {
    logger.info("moderation.reviewFlaggedImage.reindex_skipped_no_subject", {
      recordId: record.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
    });
  }

  // FR-009: notify the uploader AFTER commit (best-effort). Skip when there is
  // no human uploader. The idempotency key is keyed on record id + outcome so a
  // moderator retry can't double-send.
  await fireDecisionNotification({
    deps,
    record,
    decision: input.decision,
    note,
  });

  logger.info("moderation.reviewFlaggedImage.decided", {
    recordId: record.id,
    decision: input.decision,
    status: targetStatus,
    actorHumanId: input.actorHumanId,
  });

  return { status: targetStatus, alreadyDecided: false };
}

async function fireDecisionNotification(args: {
  deps: ReviewFlaggedImageDeps;
  record: ImageModerationRecord;
  decision: "APPROVE" | "REJECT";
  note: string | null;
}): Promise<void> {
  const { deps, record, decision, note } = args;
  if (!deps.notify || !record.createdByHumanId) {
    return;
  }

  const idempotencySuffix = decision === "APPROVE" ? "approved" : "rejected";
  const base = normalizeAppBaseUrl(deps.appBaseUrl);

  // Which event is this image on? Best-effort: a lookup failure or a deleted
  // event degrades to nulls and the notice still goes out.
  const subject = await resolveImageModerationSubject({
    record,
    repos: deps.repos,
    appBaseUrl: deps.appBaseUrl,
    logger: deps.logger,
    reportError: deps.reportError,
  });

  try {
    await deps.notify({
      humanId: record.createdByHumanId,
      variant: decision === "APPROVE" ? APPROVED_VARIANT : REJECTED_VARIANT,
      payload: {
        recordId: record.id,
        kind: record.kind,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        subjectTitle: subject.subjectTitle,
        subjectUrl: subject.subjectUrl,
        imageUrl: record.publicUrl,
        // Same Help Center footer as the HOLD notice — all three notices in the
        // sequence should offer the same way out.
        helpUrl: base ? `${base}/help` : null,
        // Reject copy may surface the moderator's note; approve has none.
        note: decision === "REJECT" ? note : null,
      },
      idempotencyKey: `image-moderation-${idempotencySuffix}:${record.id}`,
    });
  } catch (error) {
    // Best-effort notify — a failure never fails the (already-committed)
    // decision. But the swallow MUST be Sentry-visible (CLAUDE.md: logger.warn
    // is NOT captured — the silent-outage bug class). Report alongside the warn,
    // guarded so a throwing reporter can never change behaviour.
    deps.logger.warn("moderation.reviewFlaggedImage.notify_failed", {
      recordId: record.id,
      humanId: record.createdByHumanId,
      decision,
      error: String(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { area: "image-moderation", reason: "notify-failed" },
        extra: { recordId: record.id, decision },
      });
    } catch {
      // best-effort only
    }
  }
}
