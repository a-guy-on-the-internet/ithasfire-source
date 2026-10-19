import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import { describeError } from "../../../lib/io";
import {
  placeClaimDecidedRenderer,
  placeClaimReceivedRenderer,
  placeDisputeDecidedRenderer,
  placeDisputeFiledRenderer,
  placeOwnershipTransferredRenderer,
} from "../../comms/direct-community-renderers";
import {
  buildDirectInAppNotice,
  type DirectInAppNotice,
} from "../../comms/direct-in-app";

/**
 * IN-APP notification feedback loops for the claim-venue flow. Every loop is
 * BEST-EFFORT: it runs AFTER its transaction commits and swallows failures with
 * a logger warning — a notification must NEVER fail the claim/review use case
 * (mirrors suggestion-notifications' discipline). Email is out of scope here;
 * only the in-app channel is wired.
 *
 * Each row's text comes from an in-app-only comms variant
 * (comms/direct-community-renderers.ts, copy in comms/copy/places-claims.ts)
 * and the row stores that variant's payload as its template, so the inbox
 * shows it in the reader's language. The stored text stays English.
 */

export type ClaimNotificationDeps = {
  // `notifications` powers every loop; `authz` is only needed to fan out to
  // admins (notifyAdminsOfClaim) — the claimant/owner loops don't require it.
  repos: Pick<Repos, "notifications"> & Partial<Pick<Repos, "authz">>;
  logger?: LoggerPort;
  /**
   * Reports a swallowed in-app failure, and a row whose template could not be
   * stored (it then stays English for every reader).
   */
  reportError?: ReporterPort;
};

const USE_CASE = "places.claimNotifications";

/** The row fields that are not the notice's text. */
type RowBase = Omit<
  CreateNotificationInput,
  "title" | "body" | "action" | "template"
>;

/**
 * Renders the notice (inside the best-effort guard: a render failure must
 * not fail the claim/review use case either) and writes the row.
 */
async function createInApp(
  deps: ClaimNotificationDeps,
  base: RowBase,
  render: () => DirectInAppNotice,
): Promise<void> {
  const notifications = deps.repos.notifications;
  if (!notifications) {
    deps.logger?.warn("claim.notifications_repo_missing", {
      humanId: base.humanId,
    });
    return;
  }
  try {
    const notice = render();
    await notifications.create({
      ...base,
      title: notice.title,
      body: notice.body,
      metadata: { ...base.metadata, variant: notice.variant },
      action: notice.action,
      template: notice.template,
    });
  } catch (error) {
    deps.logger?.warn("claim.in_app_failed", {
      humanId: base.humanId,
      error: describeError(error),
    });
    reportSwallowed(deps, error, { humanId: base.humanId });
  }
}

function reportSwallowed(
  deps: ClaimNotificationDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, { tags: { useCase: USE_CASE }, extra });
  } catch {
    // A throwing reporter must never fail the claim/review use case.
  }
}

/** FR-004 — tell platform admins a new ownership claim/dispute is waiting. */
export async function notifyAdminsOfClaim(
  deps: ClaimNotificationDeps,
  params: {
    placeId: string;
    placeName: string;
    requestId: string;
    source: "OWNERSHIP_CLAIM" | "OWNERSHIP_DISPUTE";
  },
): Promise<void> {
  try {
    if (!deps.repos.authz) {
      deps.logger?.warn("claim.notify_admins_no_authz", {
        requestId: params.requestId,
      });
      return;
    }
    const admins = await deps.repos.authz.listHumanIdsByStaffRole("ADMIN");
    // Rendered once for every admin (inside this guard), so a payload that
    // cannot be stored is reported once, not once per admin.
    const notice = buildDirectInAppNotice(
      deps,
      placeClaimReceivedRenderer,
      {
        placeId: params.placeId,
        placeName: params.placeName,
        requestId: params.requestId,
        source: params.source,
      },
      { useCase: USE_CASE },
    );
    await Promise.all(
      admins.map((humanId) =>
        createInApp(
          deps,
          {
            humanId,
            kind: "INFO",
            metadata: {
              placeId: params.placeId,
              requestId: params.requestId,
              source: params.source,
            },
            tags: ["place", "claim"],
          },
          () => notice,
        ),
      ),
    );
  } catch (error) {
    deps.logger?.warn("claim.notify_admins_failed", {
      requestId: params.requestId,
      error: describeError(error),
    });
    reportSwallowed(deps, error, { requestId: params.requestId });
  }
}

/** FR-007 — tell the claimant the outcome of their claim. */
export async function notifyClaimantOfDecision(
  deps: ClaimNotificationDeps,
  params: {
    claimantHumanId: string;
    placeId: string;
    placeName: string;
    decision: "APPROVED" | "REJECTED";
    reviewerNotes: string | null;
  },
): Promise<void> {
  const approved = params.decision === "APPROVED";
  await createInApp(
    deps,
    {
      humanId: params.claimantHumanId,
      kind: approved ? "SUCCESS" : "INFO",
      metadata: { placeId: params.placeId, decision: params.decision },
      tags: ["place", "claim"],
    },
    () =>
      buildDirectInAppNotice(
        deps,
        placeClaimDecidedRenderer,
        {
          placeId: params.placeId,
          placeName: params.placeName,
          decision: params.decision,
          reviewerNotes: params.reviewerNotes,
        },
        { useCase: USE_CASE },
      ),
  );
}

/** Dispute outcome → the disputant (mirrors notifyClaimantOfDecision). */
export async function notifyDisputantOfDecision(
  deps: ClaimNotificationDeps,
  params: {
    disputantHumanId: string;
    placeId: string;
    placeName: string;
    decision: "APPROVED" | "REJECTED";
    reviewerNotes: string | null;
  },
): Promise<void> {
  const approved = params.decision === "APPROVED";
  await createInApp(
    deps,
    {
      humanId: params.disputantHumanId,
      kind: approved ? "SUCCESS" : "INFO",
      metadata: { placeId: params.placeId, decision: params.decision },
      tags: ["place", "dispute"],
    },
    () =>
      buildDirectInAppNotice(
        deps,
        placeDisputeDecidedRenderer,
        {
          placeId: params.placeId,
          placeName: params.placeName,
          decision: params.decision,
          reviewerNotes: params.reviewerNotes,
        },
        { useCase: USE_CASE },
      ),
  );
}

/**
 * Approved dispute → each PREVIOUS owner (human) whose ownership was revoked
 * by the transfer. Org-owner member fan-out is deferred, mirroring
 * notifyOwnerOfDispute. TODO(claim-venue): notify org members when a revoked
 * owner is an ORGANIZATION.
 */
export async function notifyOwnerOfOwnershipTransfer(
  deps: ClaimNotificationDeps,
  params: {
    ownerHumanId: string;
    placeId: string;
    placeName: string;
    requestId: string;
  },
): Promise<void> {
  await createInApp(
    deps,
    {
      humanId: params.ownerHumanId,
      kind: "WARNING",
      metadata: { placeId: params.placeId, requestId: params.requestId },
      tags: ["place", "dispute"],
    },
    () =>
      buildDirectInAppNotice(
        deps,
        placeOwnershipTransferredRenderer,
        {
          placeId: params.placeId,
          placeName: params.placeName,
          requestId: params.requestId,
        },
        { useCase: USE_CASE },
      ),
  );
}

/** FR-008 — tell the current verified owner a dispute was filed against them. */
export async function notifyOwnerOfDispute(
  deps: ClaimNotificationDeps,
  params: {
    ownerHumanId: string;
    placeId: string;
    placeName: string;
    requestId: string;
  },
): Promise<void> {
  await createInApp(
    deps,
    {
      humanId: params.ownerHumanId,
      kind: "WARNING",
      metadata: { placeId: params.placeId, requestId: params.requestId },
      tags: ["place", "dispute"],
    },
    () =>
      buildDirectInAppNotice(
        deps,
        placeDisputeFiledRenderer,
        {
          placeId: params.placeId,
          placeName: params.placeName,
          requestId: params.requestId,
        },
        { useCase: USE_CASE },
      ),
  );
}
