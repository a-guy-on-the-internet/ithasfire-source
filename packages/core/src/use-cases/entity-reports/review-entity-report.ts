import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  ENTITY_REPORT_REVIEW_NOTE_MAX,
  PLATFORM_STAFF_ROLES,
  entityReportRecordSchema,
} from "./_shared/entity-report-validation";
import { notifyEntityReportReviewed } from "./_shared/entity-report-notifications";

/**
 * FR-005/FR-006 (entity-report-intake spec v1.1): PLATFORM staff
 * (ADMIN/SUPPORT/DEVELOPER — entity reports are platform-level T&S, so
 * COMMUNITY_MODERATOR has no access) set a terminal verdict
 * (RESOLVED | DISMISSED) + optional note on a PENDING report. The verdict is
 * a record only — it never auto-takedowns or modifies the subject (takedown
 * stays ADMIN-only per the parent spec).
 *
 * ORDERING (authz vs claim — mirrors review-event-edit-suggestion's
 * rationale): the claim stamps the verdict on the PENDING row, so claiming
 * BEFORE authz would let a forbidden actor burn the claim (the legitimate
 * reviewer would then see ALREADY_REVIEWED on a row nobody reviewed). Authz
 * therefore runs FIRST, before any repo call; the single-step CAS
 * (`claimPendingForReview`, status guard in the WHERE) remains the atomic
 * double-review guard between two AUTHORIZED reviewers — the loser sees null,
 * re-reads, and reports the right error.
 *
 * NO self-review block (deliberate, unlike the suggestions family's
 * four-eyes rule): a suggestion self-approval mutates a public listing with
 * one actor, but resolving a report changes NOTHING but the report row — a
 * staff member reviewing their own report merely closes their own report,
 * which is harmless. A staff member reporting a listing and a different
 * staff member reviewing it stays the normal flow.
 */

export const reviewEntityReportInputSchema = z
  .object({
    reportId: z.uuid(),
    verdict: z.enum(["RESOLVED", "DISMISSED"]),
    /** Sanitized (tags/controls stripped, trimmed) BEFORE the max check. */
    reviewNote: plainTextMultilineOptional(ENTITY_REPORT_REVIEW_NOTE_MAX).optional(),
    actorHumanId: z.uuid(),
  })
  .strict();

export const reviewEntityReportOutputSchema = z
  .object({
    report: entityReportRecordSchema,
  })
  .strict();

export type ReviewEntityReportInput = z.infer<
  typeof reviewEntityReportInputSchema
>;
export type ReviewEntityReportOutput = z.infer<
  typeof reviewEntityReportOutputSchema
>;

export type ReviewEntityReportDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Sentry hook for the post-commit notification swallow branches (CLAUDE.md
   * Sentry convention: warn is not captured). Guarded downstream — a throwing
   * reporter never fails the committed review.
   */
  reportError?: ReporterPort;
};

export async function reviewEntityReport(
  deps: ReviewEntityReportDeps,
  rawInput: unknown,
): Promise<ReviewEntityReportOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "reviewEntityReport" });

  const execute = async (): Promise<ReviewEntityReportOutput> => {
    const input = parseInput(reviewEntityReportInputSchema, rawInput);
    const reviewNote = normalizeOptionalNote(input.reviewNote);

    // ── Authz FIRST, before ANY repo call (see module doc comment) ──────────
    // Platform staff only (throws STAFF_ONLY, the helper's default).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: PLATFORM_STAFF_ROLES,
    });

    const reviewed = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();

      // ── Atomic claim (double-review guard) ─────────────────────────────
      const claimed = await tx.entityReports.claimPendingForReview({
        id: input.reportId,
        status: input.verdict,
        reviewedByHumanId: input.actorHumanId,
        reviewedAt: now,
        reviewNote,
      });

      if (!claimed) {
        // CAS matched zero rows — disambiguate: the row is either missing or
        // already carries a verdict. Two DISTINCT errors so the queue UI can
        // tell "gone" from "someone beat you to it".
        const existing = await tx.entityReports.getById(input.reportId);
        if (!existing) {
          throw fail("NOT_FOUND", {
            message: "entity_report_not_found",
            meta: { entity: "entity_report", reportId: input.reportId },
          });
        }
        throw fail("CONFLICT", {
          message: "report_already_reviewed",
          meta: {
            reason: "report_already_reviewed",
            reportId: input.reportId,
            status: existing.status,
          },
        });
      }

      await tx.audit.log({
        entity: "entity_report",
        entityId: claimed.id,
        action: "entity_report.reviewed",
        data: {
          actorHumanId: input.actorHumanId,
          subjectType: claimed.subjectType,
          subjectId: claimed.subjectId,
          verdict: input.verdict,
          status: claimed.status,
          reviewNote,
        },
        at: now,
      });

      return claimed;
    });

    // FR-006: reporter feedback loop. Best-effort and AFTER commit — a
    // notification failure never fails the review. Every swallow inside
    // keeps its logger.warn AND reports via the guarded `reportError`
    // (NFR-003 / CLAUDE.md Sentry convention). No other catch-and-fallback
    // branch exists in this use case.
    await notifyEntityReportReviewed(
      {
        repos: deps.repos,
        logger: scopedLogger ?? deps.logger,
        reportError: deps.reportError,
      },
      { report: reviewed },
    );

    return reviewEntityReportOutputSchema.parse({ report: reviewed });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("reviewEntityReport", execute);
  }

  return execute();
}

/** Empty-after-sanitize notes collapse to null (stored as SQL NULL). */
function normalizeOptionalNote(note: string | undefined): string | null {
  if (!note) return null;
  return note.length > 0 ? note : null;
}
