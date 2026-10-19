import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EarlyFraudWarningRecord } from "@th/ports/repos/early-fraud-warnings";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { ReporterPort } from "@th/ports/reporter";
import { formatOrderCode } from "@th/types/order-identifier";

import { formatCents } from "../../../lib/currency-utils";
import { describeError } from "../../../lib/io";
import { trimTrailingSlash } from "../../../lib/url";
import type { DisputeDiscordAlert } from "../notify-dispute-lifecycle";

// ─────────────────────────────────────────────────────────────────────────────
// notifyEarlyFraudWarningOps — the Discord ping that gets ops to a refund
// button while there is still time to avoid the chargeback.
//
// OPS ONLY, BY DESIGN. No organizer email / in-app notice in v1: the refund
// decision is ops' (the platform is merchant of record and eats the dispute
// fee), and an issuer's fraud flag is about the BUYER — a notice that reaches
// the organizer can reach the buyer (organizer forwards it, buyer is the
// organizer, small-venue group inbox). Tipping off a fraudulent cardholder
// before the refund lands is the one outcome this alert must not produce.
//
// Same conventions as `notifyDisputeLifecycle`'s ops branch: `deps.discordAlert`
// is optional, every failure is logged + reported and never thrown, and the
// display lookups (buyer email, owner name, admin slug) degrade to "unknown"
// rather than block the alert.
// ─────────────────────────────────────────────────────────────────────────────

export type EarlyFraudWarningNotifyDeps = {
  repos: Pick<Repos, "humans" | "organizations">;
  discordAlert?: DisputeDiscordAlert | null;
  publicAppUrl?: string | null;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

export type EarlyFraudWarningNotificationContext = {
  warning: EarlyFraudWarningRecord;
  order: OrderRecord | null;
  event: EventRecord | null;
  stripeEventId: string | null;
};

export const EARLY_FRAUD_WARNING_ALERT_TITLE =
  "Early fraud warning — refund now to avoid a chargeback";

/**
 * `jane@example.com` → `j***@example.com`. The domain stays (ops recognise
 * a disposable-mail domain at a glance); the local part is reduced to its
 * first character so the alert channel never carries a full buyer address.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "unknown";
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "unknown";
  return `${email[0]}***${email.slice(at)}`;
}

function safeReport(
  deps: EarlyFraudWarningNotifyDeps,
  error: unknown,
  stage: string,
  extra?: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { area: "early_fraud_warning_notify", stage },
      extra,
    });
  } catch {
    // Reporting is fire-and-forget.
  }
}

export async function notifyEarlyFraudWarningOps(
  deps: EarlyFraudWarningNotifyDeps,
  context: EarlyFraudWarningNotificationContext,
): Promise<{ alerted: boolean }> {
  if (!deps.discordAlert) return { alerted: false };

  const { warning, order, event } = context;
  const orderCode = order ? `#${formatOrderCode(order.id)}` : "unlinked";
  const amount = order
    ? formatCents(order.amountGrossCents, order.currency)
    : "unknown";
  const eventLabel = event
    ? event.title
    : order?.kind === "MEMBERSHIP"
      ? "Membership order"
      : order
        ? "unknown event"
        : "unlinked";

  const [buyer, owner, refundUrl] = await Promise.all([
    lookup(deps, context, "buyer", async () =>
      order ? maskEmail((await deps.repos.humans.getByIdWithIdentity(order.buyerHumanId))?.identity.email) : "unlinked",
    ),
    lookup(deps, context, "owner", () => resolveOwnerLabel(deps, warning)),
    lookup(deps, context, "refund_link", () => resolveRefundUrl(deps, warning, order)),
  ]);

  const base = appBase(deps.publicAppUrl);
  const platformUrl = order
    ? `${base}/platform/orders?orderId=${encodeURIComponent(order.id)}`
    : null;

  try {
    await deps.discordAlert({
      title: EARLY_FRAUD_WARNING_ALERT_TITLE,
      colour: "warning",
      description: [
        `The card issuer flagged this charge as likely fraud (${warning.fraudType}). A full refund now means no dispute, no dispute fee and no dispute-ratio hit.`,
        order && order.kind !== "MEMBERSHIP"
          ? "Refund from the org admin order page (link below). Ops decision only — the organizer has not been notified."
          : order
            ? "Membership invoice — the org orders panel cannot open it; refund the charge in the Stripe Dashboard. Ops decision only — the organizer has not been notified."
            : "No local order matched this charge — find it by charge id in the Stripe Dashboard and refund there.",
      ].join("\n"),
      fields: [
        { name: "Order", value: orderCode, inline: true },
        { name: "Amount", value: amount, inline: true },
        { name: "Fraud type", value: warning.fraudType, inline: true },
        { name: "Buyer", value: buyer ?? "unknown", inline: true },
        { name: "Event", value: eventLabel, inline: true },
        { name: "Owner", value: owner ?? "unknown", inline: true },
        { name: "Actionable", value: warning.actionable ? "yes" : "no", inline: true },
        { name: "Charge", value: warning.stripeChargeId, inline: true },
        { name: "Refund", value: refundUrl ?? "n/a" },
        ...(platformUrl ? [{ name: "Platform view", value: platformUrl }] : []),
      ],
    });
    return { alerted: true };
  } catch (error) {
    deps.logger?.warn("early_fraud_warning.ops_alert_failed", {
      earlyFraudWarningId: warning.id,
      stripeEfwId: warning.stripeEfwId,
      error: describeError(error),
    });
    safeReport(deps, error, "ops_alert", {
      earlyFraudWarningId: warning.id,
      stripeEfwId: warning.stripeEfwId,
      stripeEventId: context.stripeEventId,
    });
    return { alerted: false };
  }
}

async function lookup<T>(
  deps: EarlyFraudWarningNotifyDeps,
  context: EarlyFraudWarningNotificationContext,
  stage: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    deps.logger?.warn("early_fraud_warning.lookup_failed", {
      earlyFraudWarningId: context.warning.id,
      stage,
      error: describeError(error),
    });
    safeReport(deps, error, stage, {
      earlyFraudWarningId: context.warning.id,
      stripeEfwId: context.warning.stripeEfwId,
    });
    return null;
  }
}

async function resolveOwnerLabel(
  deps: EarlyFraudWarningNotifyDeps,
  warning: EarlyFraudWarningRecord,
): Promise<string> {
  if (warning.ownerOrgId) {
    const org = await deps.repos.organizations.getById(warning.ownerOrgId);
    return org?.name ?? warning.ownerOrgId;
  }
  if (warning.ownerHumanId) {
    const human = await deps.repos.humans.getByIdWithIdentity(warning.ownerHumanId);
    return human?.human.name ?? human?.identity.displayUsername ?? warning.ownerHumanId;
  }
  return "unlinked";
}

/**
 * The org admin orders page pre-filters on `?q=<order code>` (the adapter's
 * `orderSearchWhere` matches a bare 8-hex code against the id suffix), which
 * is where the Refund action lives (`OrderDetailPanel`). Human-owned events
 * use the `@username` admin slug, same as `resolveActorAdminSlug` in
 * places/notify-availability-setup-needed.ts.
 *
 * MEMBERSHIP orders get no link: `getOrgOrder` throws
 * `EXPECTED_TICKETING_ORDER` for them, so the panel cannot open the order —
 * the alert points ops at the Stripe Dashboard instead.
 */
async function resolveRefundUrl(
  deps: EarlyFraudWarningNotifyDeps,
  warning: EarlyFraudWarningRecord,
  order: OrderRecord | null,
): Promise<string | null> {
  if (!order || order.kind === "MEMBERSHIP") return null;
  const base = appBase(deps.publicAppUrl);
  const query = `orders?q=${encodeURIComponent(formatOrderCode(order.id))}`;

  if (warning.ownerOrgId) {
    const org = await deps.repos.organizations.getById(warning.ownerOrgId);
    const slug = org?.slug || warning.ownerOrgId;
    return `${base}/admin/${encodeURIComponent(slug)}/${query}`;
  }
  if (warning.ownerHumanId) {
    const human = await deps.repos.humans.getByIdWithIdentity(warning.ownerHumanId);
    const username = human?.identity.username ?? null;
    const slug = username ? `@${encodeURIComponent(username)}` : `@${warning.ownerHumanId}`;
    return `${base}/admin/${slug}/${query}`;
  }
  return null;
}

// Same local-dev fallback the sibling notifiers use when PUBLIC_WEB_URL is
// unset, so the link is clickable rather than a bare path.
const DEFAULT_PUBLIC_APP_URL = "http://127.0.0.1:3000";

function appBase(publicAppUrl: string | null | undefined): string {
  return trimTrailingSlash(
    publicAppUrl?.trim() ? publicAppUrl : DEFAULT_PUBLIC_APP_URL,
  );
}
