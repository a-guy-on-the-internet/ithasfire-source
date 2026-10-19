import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { DisputeRecord, DisputeStatus } from "@th/ports/repos/disputes";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";
import type { OrgRole } from "@th/types/repos/authz";

import { formatCents } from "../../lib/currency-utils";
import { describeError } from "../../lib/io";
import { trimTrailingSlash } from "../../lib/url";
import { buildDirectInAppNotice } from "../comms/direct-in-app";
import {
  disputeRiskOwnerNoticeRenderer,
  type DisputeRiskOwnerNoticePayload,
} from "../comms/direct-money-safety-renderers";
import type { StripeDisputeLifecycleInput } from "./schemas";
import type { DisputeLifecycleOperation } from "./shared";

const RISK_OWNER_ORG_ROLES = new Set<OrgRole>([
  "OWNER",
  "ADMIN",
  "FINANCE",
]);

export type DisputeDiscordAlert = (opts: {
  title: string;
  colour?: "info" | "warning" | "error";
  fields?: { name: string; value: string; inline?: boolean }[];
  description?: string;
}) => Promise<void>;

export type DisputeLifecycleCommunicationsDeps = {
  mailer?: MailerPort | null;
  publicAppUrl?: string | null;
  discordAlert?: DisputeDiscordAlert | null;
};

export type DisputeLifecycleNotificationContext = {
  operation: DisputeLifecycleOperation;
  input: StripeDisputeLifecycleInput;
  dispute: DisputeRecord;
  order: OrderRecord | null;
  event: EventRecord | null;
  /**
   * What the LOST pass actually did to the ledger, so the copy never claims
   * a deduction that was not written. `null` on every non-LOST pass (and on
   * a LOST pass with no linked order/owner, which notifies nobody).
   */
  lossRecovery: {
    /** A `dispute-debit:` principal entry was written or replayed. */
    principalDebited: boolean;
    /** A `dispute-debit-fee:` entry was written or replayed (membership). */
    feeDebited: boolean;
  } | null;
};

type DisputeLifecycleNotifyDeps = DisputeLifecycleCommunicationsDeps & {
  repos: Repos;
  logger?: LoggerPort;
  // Sentry hook for the catch-and-degrade branches below. This notifier tells
  // payees money left their balance, so a swallowed failure must be visible
  // beyond `logger.warn` (warn is NOT captured by Sentry — see CLAUDE.md).
  reportError?: ReporterPort | null;
};

type RiskOwnerRecipient = {
  humanId: string;
  email: string | null;
  name: string | null;
};

type MessageCopy = {
  title: string;
  subject: string;
  body: string;
  kind: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  /** The in-app row's variant and stored template (reader's-language re-render). */
  variant: string;
  template: CreateNotificationInput["template"];
};

// Best-effort error reporting for the swallow branches: a missing OR throwing
// reporter must never change notify behaviour. Mirrors `safeReport` in
// settlements/run-batch.ts.
function safeReport(
  deps: DisputeLifecycleNotifyDeps,
  error: unknown,
  stage: string,
  extra?: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { area: "dispute_notify", stage },
      extra,
    });
  } catch {
    // Swallow — reporting is fire-and-forget.
  }
}

export async function notifyDisputeLifecycle(
  deps: DisputeLifecycleNotifyDeps,
  context: DisputeLifecycleNotificationContext,
): Promise<void> {
  try {
    await notifyRiskOwner(deps, context);
  } catch (error) {
    deps.logger?.warn("dispute.lifecycle.risk_owner_notify_failed", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
      error: describeError(error),
    });
    safeReport(deps, error, "risk_owner_notify", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
    });
  }

  try {
    await notifyOps(deps, context);
  } catch (error) {
    deps.logger?.warn("dispute.lifecycle.ops_notify_failed", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
      error: describeError(error),
    });
    safeReport(deps, error, "ops_notify", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
    });
  }
}

async function notifyRiskOwner(
  deps: DisputeLifecycleNotifyDeps,
  context: DisputeLifecycleNotificationContext,
): Promise<void> {
  if (!shouldNotifyRiskOwner(context)) return;

  let recipients: RiskOwnerRecipient[] = [];
  try {
    recipients = await resolveRiskOwnerRecipients(deps.repos, context.dispute);
  } catch (error) {
    deps.logger?.warn("dispute.lifecycle.recipient_resolution_failed", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
      error: describeError(error),
    });
    safeReport(deps, error, "recipient_resolution", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
    });
    return;
  }

  if (recipients.length === 0) {
    deps.logger?.warn("dispute.lifecycle.risk_owner_recipients_missing", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
      ownerOrgId: context.dispute.ownerOrgId,
      ownerHumanId: context.dispute.ownerHumanId,
    });
    return;
  }

  const copy = buildRiskOwnerCopy(deps, context);
  const tags = ["dispute", "payments", statusTag(context.dispute.status)];
  const metadata = buildMetadata(context);

  await Promise.all(
    recipients.map(async (recipient) => {
      await createInAppNotification(deps, recipient, copy, tags, metadata);
      await sendEmail(deps, context, recipient, copy, tags, metadata);
    }),
  );
}

async function createInAppNotification(
  deps: DisputeLifecycleNotifyDeps,
  recipient: RiskOwnerRecipient,
  copy: MessageCopy,
  tags: string[],
  metadata: Record<string, string>,
): Promise<void> {
  const notifications = deps.repos.notifications;
  if (!notifications) {
    deps.logger?.warn("dispute.lifecycle.notifications_repo_missing", {
      humanId: recipient.humanId,
      disputeId: metadata.disputeId,
    });
    return;
  }

  try {
    await notifications.create({
      humanId: recipient.humanId,
      title: copy.title,
      body: copy.body,
      kind: copy.kind,
      metadata: { ...metadata, variant: copy.variant },
      tags,
      template: copy.template,
    });
  } catch (error) {
    deps.logger?.warn("dispute.lifecycle.in_app_failed", {
      humanId: recipient.humanId,
      disputeId: metadata.disputeId,
      error: describeError(error),
    });
    safeReport(deps, error, "in_app", {
      humanId: recipient.humanId,
      disputeId: metadata.disputeId,
    });
  }
}

async function sendEmail(
  deps: DisputeLifecycleNotifyDeps,
  context: DisputeLifecycleNotificationContext,
  recipient: RiskOwnerRecipient,
  copy: MessageCopy,
  tags: string[],
  metadata: Record<string, string>,
): Promise<void> {
  if (!deps.mailer || !recipient.email) return;

  try {
    const result = await deps.mailer.send({
      to: { to: recipient.email, name: recipient.name ?? undefined },
      subject: copy.subject,
      text: buildEmailText(copy, context, deps.publicAppUrl ?? null),
      idempotencyKey: buildMailerIdempotencyKey(context, recipient.humanId),
      metadata,
      tags,
    });

    if (!result.result.success) {
      deps.logger?.warn("dispute.lifecycle.email_failed", {
        humanId: recipient.humanId,
        disputeId: context.dispute.id,
        errorCode: result.result.errorCode ?? null,
        errorMessage: result.result.errorMessage ?? null,
      });
      // The mailer degraded without throwing — synthesize an error so the
      // failed dispute email (money-movement notice) still reaches Sentry.
      safeReport(
        deps,
        new Error(
          `dispute_lifecycle_email_failed: ${result.result.errorCode ?? "unknown"}`,
        ),
        "email",
        {
          humanId: recipient.humanId,
          disputeId: context.dispute.id,
          errorCode: result.result.errorCode ?? null,
          errorMessage: result.result.errorMessage ?? null,
        },
      );
    }
  } catch (error) {
    deps.logger?.warn("dispute.lifecycle.email_failed", {
      humanId: recipient.humanId,
      disputeId: context.dispute.id,
      error: describeError(error),
    });
    safeReport(deps, error, "email", {
      humanId: recipient.humanId,
      disputeId: context.dispute.id,
    });
  }
}

async function notifyOps(
  deps: DisputeLifecycleNotifyDeps,
  context: DisputeLifecycleNotificationContext,
): Promise<void> {
  if (!shouldNotifyOps(context)) return;
  if (!deps.discordAlert) return;

  try {
    await deps.discordAlert({
      title: buildOpsTitle(context),
      colour: opsAlertColour(context.dispute.status),
      description: buildOpsDescription(context),
      fields: [
        { name: "Dispute", value: context.dispute.stripeDisputeId, inline: true },
        { name: "Order", value: context.dispute.orderId ?? "none", inline: true },
        {
          name: "Amount",
          value: formatCents(context.dispute.amountCents, context.dispute.currency),
          inline: true,
        },
        { name: "Status", value: context.dispute.status, inline: true },
        {
          name: "Evidence due",
          value: formatDateTime(context.dispute.evidenceDueBy),
          inline: true,
        },
        {
          name: "Triage reason",
          value: context.dispute.triageReason ?? "none",
          inline: true,
        },
      ],
    });
  } catch (error) {
    deps.logger?.warn("dispute.lifecycle.ops_alert_failed", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
      error: describeError(error),
    });
    safeReport(deps, error, "ops_alert", {
      disputeId: context.dispute.id,
      stripeDisputeId: context.dispute.stripeDisputeId,
    });
  }
}

function shouldNotifyRiskOwner(
  context: DisputeLifecycleNotificationContext,
): boolean {
  const status = context.dispute.status;
  if (isWarningStatus(status) || status === "NEEDS_TRIAGE") return false;
  if (!context.order) return false;
  // Membership orders have no event by construction — the owner (resolved
  // from the order's payee) still must hear about holds and debits against
  // their balance. Everything else without an event is unlinked/triage-bound.
  if (!context.event && context.order.kind !== "MEMBERSHIP") return false;
  if (!context.dispute.ownerOrgId && !context.dispute.ownerHumanId) return false;

  if (context.operation === "open") return status === "OPEN";
  if (context.operation === "refresh") return status === "UNDER_REVIEW";
  if (context.operation === "funds_withdrawn") {
    return status === "OPEN" || status === "UNDER_REVIEW";
  }
  if (context.operation === "close") return status === "WON" || status === "LOST";

  return false;
}

function shouldNotifyOps(context: DisputeLifecycleNotificationContext): boolean {
  const status = context.dispute.status;
  if (status === "NEEDS_TRIAGE" || isWarningStatus(status)) return true;

  if (context.operation === "open") return status === "OPEN";
  if (context.operation === "refresh") return status === "UNDER_REVIEW";
  if (context.operation === "funds_withdrawn") {
    return status === "OPEN" || status === "UNDER_REVIEW";
  }
  if (context.operation === "close") return status === "WON" || status === "LOST";

  return false;
}

async function resolveRiskOwnerRecipients(
  repos: Repos,
  dispute: DisputeRecord,
): Promise<RiskOwnerRecipient[]> {
  if (dispute.ownerOrgId) {
    return resolveOrgRiskOwnerRecipients(repos, dispute.ownerOrgId);
  }

  if (dispute.ownerHumanId) {
    const human = await repos.humans.getByIdWithIdentity(dispute.ownerHumanId);
    return human
      ? [
          {
            humanId: dispute.ownerHumanId,
            email: human.identity.email,
            name: human.human.name ?? human.identity.displayUsername ?? null,
          },
        ]
      : [];
  }

  return [];
}

async function resolveOrgRiskOwnerRecipients(
  repos: Repos,
  orgId: string,
): Promise<RiskOwnerRecipient[]> {
  const recipients = new Map<string, RiskOwnerRecipient>();
  const limit = 100;
  let offset = 0;
  let total = 0;

  do {
    const page = await repos.organizations.listMembers({ orgId, limit, offset });
    total = page.total;

    for (const member of page.items) {
      if (!RISK_OWNER_ORG_ROLES.has(member.role)) continue;
      recipients.set(member.humanId, {
        humanId: member.humanId,
        email: member.email,
        name: member.name,
      });
    }

    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);

  return [...recipients.values()];
}

/**
 * The risk owners' notice. The in-app title/body are rendered from the
 * `dispute.risk-owner-notice` variant (comms/direct-money-safety-renderers.ts,
 * copy in comms/copy/disputes.ts) so the row can be re-rendered in the
 * reader's language; the email reuses the English body, and its subject stays
 * here.
 */
function buildRiskOwnerCopy(
  deps: DisputeLifecycleNotifyDeps,
  context: DisputeLifecycleNotificationContext,
): MessageCopy {
  const amount = formatCents(context.dispute.amountCents, context.dispute.currency);
  const isMembership = context.order?.kind === "MEMBERSHIP";
  // A membership dispute has no event; never render "your event" for it.
  const subjectTitle =
    context.event?.title ?? (isMembership ? "your membership" : "your event");
  const evidenceDue = formatDate(context.dispute.evidenceDueBy);

  const notice = riskOwnerNotice(context);
  const payload: DisputeRiskOwnerNoticePayload = {
    disputeId: context.dispute.id,
    notice,
    eventTitle: context.event?.title ?? null,
    isMembership,
    evidenceDueIso: context.dispute.evidenceDueBy?.toISOString() ?? null,
    lostOutcome: notice === "lost" ? lostOutcome(context, isMembership) : null,
  };
  const row = buildDirectInAppNotice(
    { logger: deps.logger, reportError: deps.reportError },
    disputeRiskOwnerNoticeRenderer,
    payload,
    { useCase: "disputes.notifyDisputeLifecycle" },
  );

  const subjectSuffix: Record<DisputeRiskOwnerNoticePayload["notice"], string> = {
    opened: `payout held, evidence due ${evidenceDue}`,
    under_review: "under review",
    funds_withdrawn: "funds withdrawn",
    won: "won",
    lost: "lost",
  };

  return {
    title: row.title,
    subject: `[Dispute] ${amount} on ${subjectTitle} - ${subjectSuffix[notice]}`,
    body: row.body,
    kind: row.kind,
    variant: row.variant,
    template: row.template ?? null,
  };
}

function riskOwnerNotice(
  context: DisputeLifecycleNotificationContext,
): DisputeRiskOwnerNoticePayload["notice"] {
  if (context.operation === "refresh" && context.dispute.status === "UNDER_REVIEW") {
    return "under_review";
  }
  if (context.operation === "funds_withdrawn") return "funds_withdrawn";
  // One "won" notice for both product lines and both timings. A plain win
  // releases the hold and nothing was ever deducted; a WON-after-LOST flip
  // reverses the realised debits on this same transition (ticketing and
  // memberships alike, since ticketing LOST now debits too). "Any amount
  // already deducted ... has been credited back" is true in both cases and
  // vacuous in the first, so the copy never lies.
  if (context.dispute.status === "WON") return "won";
  if (context.dispute.status === "LOST") return "lost";
  return "opened";
}

/**
 * Copy follows what the ledger pass DID. A LOST close can legitimately debit
 * nothing — the payee's share was already refunded (hold released,
 * `nothing_retained_from_order`) or Stripe's close amount allocated nothing to
 * it (`dispute_amount_below_hold`) — and telling them "the disputed amount
 * will be deducted" would then be false. A missing outcome (legacy caller)
 * keeps the deducted wording.
 */
function lostOutcome(
  context: DisputeLifecycleNotificationContext,
  isMembership: boolean,
): NonNullable<DisputeRiskOwnerNoticePayload["lostOutcome"]> {
  const principalDebited = context.lossRecovery?.principalDebited ?? true;
  if (isMembership) {
    // Memberships are debited, not held-for-clawback: the payee sold the
    // recurring subscription and was told at setup that lost disputes are
    // debited (spec: "Absorb on ticketing, debit to the payee on
    // memberships"). "Will be deducted", not "has been debited": the ledger
    // debit is written, but collection happens against upcoming payouts.
    if (principalDebited) {
      return context.dispute.feeCents > 0
        ? "membership_debited_with_fee"
        : "membership_debited";
    }
    return context.lossRecovery?.feeDebited
      ? "membership_fee_debited"
      : "membership_not_debited";
  }
  // Ticketing: the principal is debited exactly like a membership (the hold
  // becomes a DISPUTE_DEBIT per payee, collected against upcoming payouts),
  // but Stripe's dispute fee stays with the platform — the copy says so,
  // because the membership copy says the opposite.
  return principalDebited ? "ticketing_debited" : "ticketing_not_debited";
}

function buildEmailText(
  copy: MessageCopy,
  context: DisputeLifecycleNotificationContext,
  publicAppUrl: string | null,
): string {
  return [
    copy.body,
    "",
    `Dispute ID: ${context.dispute.stripeDisputeId}`,
    context.dispute.orderId ? `Order ID: ${context.dispute.orderId}` : null,
    `Amount: ${formatCents(context.dispute.amountCents, context.dispute.currency)}`,
    `Reason: ${context.dispute.reason}`,
    context.dispute.evidenceDueBy
      ? `Evidence due: ${formatDate(context.dispute.evidenceDueBy)}`
      : null,
    appUrlLine(publicAppUrl),
    "",
    "Ithas Fire Support",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function appUrlLine(publicAppUrl: string | null): string | null {
  if (publicAppUrl?.trim()) {
    return `Ithas Fire: ${trimTrailingSlash(publicAppUrl)}`;
  }
  return null;
}

function buildMailerIdempotencyKey(
  context: DisputeLifecycleNotificationContext,
  humanId: string,
): string {
  const eventPart = context.input.stripeEventId ?? `${context.operation}:${context.dispute.id}`;
  return `dispute-lifecycle:${eventPart}:${humanId}`;
}

function buildOpsTitle(context: DisputeLifecycleNotificationContext): string {
  if (context.dispute.status === "NEEDS_TRIAGE") return "Dispute needs triage";
  if (isWarningStatus(context.dispute.status)) return "Dispute warning received";
  if (context.operation === "funds_withdrawn") return "Dispute funds withdrawn";
  if (context.dispute.status === "WON") return "Dispute won";
  if (context.dispute.status === "LOST") return "Dispute lost";
  if (context.dispute.status === "UNDER_REVIEW") return "Dispute under review";
  return "Dispute opened";
}

function buildOpsDescription(context: DisputeLifecycleNotificationContext): string {
  const eventTitle =
    context.event?.title ??
    (context.order?.kind === "MEMBERSHIP" ? "Membership order" : "unknown event");
  const warningNote = isWarningStatus(context.dispute.status)
    ? "Warning event only; no risk-owner payout-hold notice was sent."
    : null;
  return [
    `${eventTitle}: ${formatCents(context.dispute.amountCents, context.dispute.currency)} dispute (${context.dispute.reason}).`,
    warningNote,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function buildMetadata(
  context: DisputeLifecycleNotificationContext,
): Record<string, string> {
  return compactMetadata({
    disputeId: context.dispute.id,
    stripeDisputeId: context.dispute.stripeDisputeId,
    stripeEventId: context.input.stripeEventId ?? null,
    orderId: context.dispute.orderId,
    eventId: context.event?.id ?? null,
    ownerOrgId: context.dispute.ownerOrgId,
    ownerHumanId: context.dispute.ownerHumanId,
    status: context.dispute.status,
    operation: context.operation,
    reason: context.dispute.reason,
    triageReason: context.dispute.triageReason,
    evidenceDueBy: context.dispute.evidenceDueBy?.toISOString() ?? null,
  });
}

function compactMetadata(
  values: Record<string, string | null>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string" && entry[1].length > 0;
    }),
  );
}

function statusTag(status: DisputeStatus): string {
  return `status-${status.toLowerCase().replace(/_/g, "-")}`;
}

function isWarningStatus(status: DisputeStatus): boolean {
  return status.startsWith("WARNING_");
}

function opsAlertColour(status: DisputeStatus): "info" | "warning" | "error" {
  if (status === "LOST" || status === "NEEDS_TRIAGE") return "error";
  if (status === "WON" || status === "WARNING_CLOSED") return "info";
  return "warning";
}

function formatDate(value: Date | null): string {
  if (!value) return "not provided";
  return value.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDateTime(value: Date | null): string {
  if (!value) return "none";
  return value.toISOString();
}