import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { EventRecord } from "@th/ports/repos/events";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import { describeError } from "../../../lib/io";
import { eventPublicPath } from "../../../lib/public-urls";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import {
  suggestionReceivedRenderer,
  suggestionReviewedRenderer,
} from "../../comms/direct-community-renderers";
import {
  buildDirectInAppNotice,
  type DirectInAppNotice,
} from "../../comms/direct-in-app";

/**
 * IN-APP notification feedback loops for the community edit-suggestion flow
 * (community-managed-event-listings spec). Both loops are BEST-EFFORT: they run
 * AFTER their transaction commits and every failure is swallowed with a
 * logger warning — a notification must NEVER fail the submit/review use case
 * (mirrors notify-dispute-lifecycle's discipline).
 *
 * Email is deliberately out of scope here; only the in-app channel is wired.
 *
 * Each row's text comes from an in-app-only comms variant
 * (comms/direct-community-renderers.ts, copy in
 * comms/copy/community-suggestions.ts) and the row stores that variant's
 * payload as its template, so the inbox shows it in the reader's language.
 * The stored text stays English.
 */

export type SuggestionNotificationDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /**
   * Reports a swallowed notification failure, and a row whose template could
   * not be stored (it then stays English for every reader).
   */
  reportError?: ReporterPort;
};

const USE_CASE = "community.suggestionNotifications";

const ORG_MEMBER_PAGE_SIZE = 100;

/**
 * Requirement A — tell the approver side a suggestion is waiting.
 * Recipients resolve from the target event's stewardship:
 *  - COMMUNITY  → every community moderator (forward staff-role lookup);
 *  - org-owned  → every member of the owning org;
 *  - personal   → just the human owner.
 * The submitter is never notified about their own suggestion.
 */
export async function notifySuggestionSubmitted(
  deps: SuggestionNotificationDeps,
  params: { event: EventRecord; suggestion: EventEditSuggestionRecord },
): Promise<void> {
  const { event, suggestion } = params;

  try {
    const recipients = await resolveApproverRecipients(deps, event);
    // Rendered once for every recipient, inside this guard.
    const notice = buildDirectInAppNotice(
      deps,
      suggestionReceivedRenderer,
      {
        eventId: event.id,
        suggestionId: suggestion.id,
        eventTitle: event.title,
        // Reviewers of a COMMUNITY listing get the moderator queue. The
        // owner-side review surface lives in the event builder's Suggestions
        // tab, which needs the org slug + event id to address — not
        // resolvable from this context — so other events get no action rather
        // than a guessed URL.
        moderatorQueue: event.stewardship === "COMMUNITY",
      },
      { useCase: USE_CASE },
    );
    const metadata = { eventId: event.id, suggestionId: suggestion.id };

    await Promise.all(
      recipients
        // Never notify yourself (a signed-in submitter who is also an approver).
        .filter((humanId) => humanId !== suggestion.submitterHumanId)
        .map((humanId) =>
          createInApp(
            deps,
            {
              humanId,
              kind: "INFO",
              metadata,
              tags: ["community", "suggestion"],
            },
            notice,
          ),
        ),
    );
  } catch (error) {
    deps.logger?.warn("suggestion.submitted_notify_failed", {
      eventId: event.id,
      suggestionId: suggestion.id,
      error: describeError(error),
    });
    reportSwallowed(deps, error, {
      eventId: event.id,
      suggestionId: suggestion.id,
    });
  }
}

/**
 * Requirement B — tell the SUBMITTER the outcome of their suggestion.
 * Anonymous submissions (`submitterHumanId === null`) get NOTHING — there is no
 * human to notify and no email/anon channel in scope. Accepted limitation.
 */
export async function notifySuggestionReviewed(
  deps: SuggestionNotificationDeps,
  params: {
    event: EventRecord;
    suggestion: EventEditSuggestionRecord;
    decision: "APPROVE" | "REJECT";
    reviewNote: string | null;
    conflictedFields: string[];
  },
): Promise<void> {
  const { event, suggestion, decision, reviewNote, conflictedFields } = params;

  // Anonymous submission → nobody to notify (accepted limitation).
  if (!suggestion.submitterHumanId) return;

  try {
    const notice = buildDirectInAppNotice(
      deps,
      suggestionReviewedRenderer,
      {
        eventId: event.id,
        suggestionId: suggestion.id,
        eventTitle: event.title,
        // Slug path, never the id: the public route resolves by slug / slug
        // history only. No slug (unpublished draft) → no action at all.
        eventRoute: eventPublicPath(event.slug),
        decision,
        reviewNote,
        conflictedFields,
      },
      { useCase: USE_CASE },
    );

    await createInApp(
      deps,
      {
        humanId: suggestion.submitterHumanId,
        kind: decision === "APPROVE" ? "SUCCESS" : "INFO",
        metadata: { eventId: event.id, suggestionId: suggestion.id, decision },
        tags: ["suggestion"],
      },
      notice,
    );
  } catch (error) {
    deps.logger?.warn("suggestion.reviewed_notify_failed", {
      eventId: event.id,
      suggestionId: suggestion.id,
      error: describeError(error),
    });
    reportSwallowed(deps, error, {
      eventId: event.id,
      suggestionId: suggestion.id,
    });
  }
}

async function resolveApproverRecipients(
  deps: SuggestionNotificationDeps,
  event: EventRecord,
): Promise<string[]> {
  if (event.stewardship === "COMMUNITY") {
    // Review authorizes COMMUNITY_MODERATOR + platform ADMIN (see
    // ensureActorCanReview's COMMUNITY_MODERATION_ROLES). We prefer notifying
    // dedicated moderators so platform admins aren't pinged on every community
    // suggestion — they can operate the /moderate queue without a per-suggestion
    // nudge. But when NO dedicated moderator exists (the seeded/early-prod
    // reality, where the only reviewer is a platform ADMIN), that preference
    // would leave the queue unwatched. So fall back to ADMINs — both are
    // permitted reviewers, and the fallback guarantees someone is notified
    // without spamming admins once real moderators are in place.
    const moderators = await deps.repos.authz.listHumanIdsByStaffRole(
      "COMMUNITY_MODERATOR",
    );
    if (moderators.length > 0) {
      return moderators;
    }
    return deps.repos.authz.listHumanIdsByStaffRole("ADMIN");
  }
  if (event.orgId) {
    return listOrgMemberHumanIds(deps, event.orgId);
  }
  if (event.humanId) {
    return [event.humanId];
  }
  return [];
}

async function listOrgMemberHumanIds(
  deps: SuggestionNotificationDeps,
  orgId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  let offset = 0;
  let total = 0;

  do {
    const page = await deps.repos.organizations.listMembers({
      orgId,
      limit: ORG_MEMBER_PAGE_SIZE,
      offset,
    });
    total = page.total;

    for (const member of page.items) {
      // Only notify members who can actually review (mirrors
      // ensureActorCanReview's ORG_EDIT_ROLES gate) — FINANCE/VIEWER/SCANNER
      // would only hit INSUFFICIENT_ROLE on the review call.
      if (!ORG_EDIT_ROLES.includes(member.role)) continue;
      ids.add(member.humanId);
    }

    if (page.items.length === 0) break;
    offset += page.items.length;
  } while (offset < total);

  return [...ids];
}

/** The row fields that are not the notice's text. */
type RowBase = Omit<
  CreateNotificationInput,
  "title" | "body" | "action" | "template"
>;

async function createInApp(
  deps: SuggestionNotificationDeps,
  base: RowBase,
  notice: DirectInAppNotice,
): Promise<void> {
  const notifications = deps.repos.notifications;
  if (!notifications) {
    deps.logger?.warn("suggestion.notifications_repo_missing", {
      humanId: base.humanId,
    });
    return;
  }

  try {
    await notifications.create({
      ...base,
      title: notice.title,
      body: notice.body,
      metadata: { ...base.metadata, variant: notice.variant },
      action: notice.action,
      template: notice.template,
    });
  } catch (error) {
    deps.logger?.warn("suggestion.in_app_failed", {
      humanId: base.humanId,
      error: describeError(error),
    });
    reportSwallowed(deps, error, { humanId: base.humanId });
  }
}

function reportSwallowed(
  deps: SuggestionNotificationDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, { tags: { useCase: USE_CASE }, extra });
  } catch {
    // A throwing reporter must never fail the submit/review use case.
  }
}
