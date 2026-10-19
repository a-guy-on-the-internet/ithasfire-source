import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EntityReportReason,
  EntityReportRecord,
  EntityReportSubjectType,
} from "@th/ports/repos/entity-reports";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import { describeError } from "../../../lib/io";
import { buildDirectInAppNotice } from "../../comms/direct-in-app";
import {
  entityReportReviewedRenderer,
  entityReportSubmittedRenderer,
  type EntityReportReviewedPayload,
  type EntityReportSubmittedPayload,
} from "../../comms/direct-money-safety-renderers";

/**
 * IN-APP notification feedback loops for the entity-report intake flow
 * (entity-report-intake spec FR-004/FR-006). Both loops are BEST-EFFORT: they
 * run AFTER their transaction commits and every failure is swallowed — a
 * notification must NEVER fail the submit/review use case.
 *
 * Every swallow branch keeps its `logger.warn` AND reports via
 * `reportError?` (guarded), per the CLAUDE.md Sentry convention for NEW
 * catch-and-fallback branches: warn alone is not Sentry-captured, and a
 * silently-failing staff notification is exactly the unwatched-queue risk
 * (spec NFR-003, updated to match the convention). The one exception is the
 * notifications-repo-missing branch — a wiring/config state, not a caught
 * error — which stays warn-only.
 *
 * Email is deliberately out of scope; only the in-app channel is wired.
 *
 * The in-app text is rendered from registered variants
 * (comms/direct-money-safety-renderers.ts, copy in comms/copy/entity-reports.ts)
 * and stored with its template, so the inbox shows it in the reader's
 * language.
 */

export type EntityReportNotificationDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /** Sentry hook for the swallow branches (never changes behaviour). */
  reportError?: ReporterPort;
};

/** Tag context threaded into every swallow branch's `reportError` call. */
type NotifyReportContext = {
  useCase: "submit-entity-report" | "review-entity-report";
  reportId: string;
};

/**
 * FR-004 (spec v1.1) — tell PLATFORM staff a report is waiting. The reporter
 * is never notified about their own report (a reporter who is also staff is
 * filtered out of the recipient list).
 */
export async function notifyEntityReportSubmitted(
  deps: EntityReportNotificationDeps,
  params: { report: EntityReportRecord },
): Promise<void> {
  const { report } = params;
  const context: NotifyReportContext = {
    useCase: "submit-entity-report",
    reportId: report.id,
  };

  try {
    const recipients = await resolvePlatformStaffRecipients(deps);
    const payload: EntityReportSubmittedPayload = {
      reportId: report.id,
      subjectType: report.subjectType,
      subjectId: report.subjectId,
      reason: report.reason,
    };
    const row = buildDirectInAppNotice(
      deps,
      entityReportSubmittedRenderer,
      payload,
      { useCase: context.useCase },
    );
    const metadata = {
      reportId: report.id,
      subjectType: report.subjectType,
      subjectId: report.subjectId,
      variant: row.variant,
    };
    const toNotify = recipients
      // Never notify yourself (a reporter who is also platform staff).
      .filter((humanId) => humanId !== report.reporterHumanId);

    await Promise.all(
      toNotify.map((humanId) =>
        createInApp(
          deps,
          {
            humanId,
            title: row.title,
            body: row.body,
            kind: row.kind,
            metadata,
            tags: ["platform", "entity-report"],
            ...(row.action ? { action: row.action } : {}),
            template: row.template ?? null,
          },
          context,
        ),
      ),
    );
  } catch (error) {
    deps.logger?.warn("entity_report.submitted_notify_failed", {
      reportId: report.id,
      subjectType: report.subjectType,
      subjectId: report.subjectId,
      error: describeError(error),
    });
    reportSwallowed(deps, error, context, {
      subjectType: report.subjectType,
      subjectId: report.subjectId,
    });
  }
}

/**
 * FR-006 — tell the REPORTER the outcome of their report: SUCCESS kind on
 * RESOLVED, INFO on DISMISSED; the body carries the reviewer's note when one
 * was left (mirrors `notifySuggestionReviewed`). No action deep-link: the
 * report has no reporter-facing detail page (no "my reports" list in v1), and
 * the subject route isn't resolvable from ids alone (slug needed) — omit
 * rather than guess a wrong URL (same posture as `approverAction`'s null).
 */
export async function notifyEntityReportReviewed(
  deps: EntityReportNotificationDeps,
  params: { report: EntityReportRecord },
): Promise<void> {
  const { report } = params;
  const context: NotifyReportContext = {
    useCase: "review-entity-report",
    reportId: report.id,
  };

  try {
    // RESOLVED reads as resolved; anything else as reviewed-no-action.
    const payload: EntityReportReviewedPayload = {
      reportId: report.id,
      subjectType: report.subjectType,
      subjectId: report.subjectId,
      verdict: report.status === "RESOLVED" ? "RESOLVED" : "DISMISSED",
      reviewNote: report.reviewNote || null,
    };
    const row = buildDirectInAppNotice(
      deps,
      entityReportReviewedRenderer,
      payload,
      { useCase: context.useCase },
    );

    await createInApp(
      deps,
      {
        humanId: report.reporterHumanId,
        title: row.title,
        body: row.body,
        kind: row.kind,
        metadata: {
          reportId: report.id,
          subjectType: report.subjectType,
          subjectId: report.subjectId,
          status: report.status,
          variant: row.variant,
        },
        tags: ["entity-report"],
        template: row.template ?? null,
      },
      context,
    );
  } catch (error) {
    deps.logger?.warn("entity_report.reviewed_notify_failed", {
      reportId: report.id,
      reporterHumanId: report.reporterHumanId,
      error: describeError(error),
    });
    reportSwallowed(deps, error, context, {
      reporterHumanId: report.reporterHumanId,
    });
  }
}

/**
 * FR-004 recipient resolution (spec v1.1): the distinct union of platform
 * ADMIN + SUPPORT staff — entity reports go DIRECTLY to the platform T&S
 * operators, with no volunteer indirection (the v1.0
 * COMMUNITY_MODERATOR→ADMIN fallback copied from the suggestions family's
 * `resolveApproverRecipients` is gone: community moderators no longer hold
 * queue access, so notifying them would dead-end). DEVELOPER holds queue
 * access via `PLATFORM_STAFF_ROLES` but is deliberately not pinged —
 * developers can operate /platform/reports without a per-report nudge.
 */
async function resolvePlatformStaffRecipients(
  deps: EntityReportNotificationDeps,
): Promise<string[]> {
  const [admins, support] = await Promise.all([
    deps.repos.authz.listHumanIdsByStaffRole("ADMIN"),
    deps.repos.authz.listHumanIdsByStaffRole("SUPPORT"),
  ]);
  return [...new Set([...admins, ...support])];
}

/**
 * Tolerant in-app create (copied from suggestion-notifications' wrapper):
 * `notifications` is optional on the Repos aggregate, and a per-recipient
 * failure must neither fail the batch nor the calling use case. Because this
 * wrapper swallows INTERNALLY, the callers' outer catches never see a
 * per-recipient create failure — so the `reportError` obligation lives HERE
 * too, not just in the outer catches.
 */
async function createInApp(
  deps: EntityReportNotificationDeps,
  input: CreateNotificationInput,
  context: NotifyReportContext,
): Promise<void> {
  const notifications = deps.repos.notifications;
  if (!notifications) {
    // Wiring/config state, not a caught error — warn-only is acceptable here
    // (the composition roots either wire the repo or don't; Sentry-reporting
    // it per notification would just be config noise).
    deps.logger?.warn("entity_report.notifications_repo_missing", {
      humanId: input.humanId,
    });
    return;
  }

  try {
    await notifications.create(input);
  } catch (error) {
    deps.logger?.warn("entity_report.in_app_failed", {
      humanId: input.humanId,
      error: describeError(error),
    });
    reportSwallowed(deps, error, context, { humanId: input.humanId });
  }
}

/**
 * Guarded `reportError` call for the swallow branches: reporting is
 * best-effort, so a throwing reporter must never turn a graceful swallow into
 * the caller's failure (same guard as reindex-after-mutation's call sites).
 */
function reportSwallowed(
  deps: EntityReportNotificationDeps,
  error: unknown,
  context: NotifyReportContext,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: {
        useCase: context.useCase,
        area: "entity_report_notifications",
      },
      extra: { reportId: context.reportId, ...extra },
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never change the
    // swallow branch's behaviour.
  }
}
