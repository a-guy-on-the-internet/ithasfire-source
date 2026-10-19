import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

/**
 * Org roles that should receive a "you've been paid out" notification when an
 * ORGANIZATION payee receives a transfer. Mirrors the risk-owner role set used
 * by the dispute lifecycle notifier (notify-dispute-lifecycle.ts).
 */
const PAYOUT_NOTIFY_ORG_ROLES = new Set<OrgRole>(["OWNER", "ADMIN", "FINANCE"]);

const NOTIFY_VARIANT = "settlement.payout-completed";

/**
 * Stripe Express accounts have no stable per-account dashboard URL; this
 * login endpoint is the one Stripe documents for "open your dashboard".
 */
const STRIPE_DASHBOARD_URL = "https://connect.stripe.com/express_login";

/**
 * At most this many "where it came from" lines ride in the email. An org
 * with hundreds of orders in one payout gets the largest ones; the template
 * shows the total count so nothing is hidden, and the read fan-out (one
 * order + one event per line) stays bounded.
 */
const MAX_LINES = 25;

/**
 * Statement budget for the maturity forecast. It is a diagnostic read that
 * only feeds one sentence of copy, so it must never be allowed to hold the
 * batch on a slow plan — the adapter enforces this as `statement_timeout`.
 */
const MATURITY_READ_BUDGET_MS = 5_000;

/**
 * Coarse ceiling on the whole enrichment. It runs INSIDE the payout loop,
 * after the money has moved; a slow event read must degrade the email to
 * the bare amounts, never hold the next payee's transfer.
 */
const ENRICHMENT_TIMEOUT_MS = 10_000;

/** Parallel order/event lookups per item — bounded, not serial. */
const LOOKUP_CONCURRENCY = 5;

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyPayoutCompletedDeps = {
  repos: Repos;
  notify: NotifyFn;
  logger?: LoggerPort;
  /**
   * Only `getConnectAccountStatus` is used — to read the connected account's
   * payout schedule so the email can say roughly when the money reaches the
   * payee's bank. Optional: without it the email says nothing about timing.
   */
  payments?: Pick<PaymentProcessorPort, "getConnectAccountStatus">;
  clock?: ClockPort;
  /**
   * Every enrichment read below is best-effort (the email still sends when
   * one fails). Per CLAUDE.md, a deliberate swallow MUST be reported here so
   * a silently degraded email is visible in Sentry.
   */
  reportError?: ReporterPort;
};

export type NotifyPayoutCompletedArgs = {
  payeeId: string;
  payoutId: string;
  payoutItemId: string;
  /**
   * For `kind: "payout"` (default), the NET cents that landed in the payee's
   * account. For `kind: "applied_to_balance"`, the cents withheld and applied
   * against their outstanding lost-dispute balance. For `kind: "reserved"`,
   * the cents deferred into the rolling reserve.
   */
  amountCents: number;
  currency: string;
  settlementCount: number;
  /**
   * How the payout item completed. Omitted/`"payout"` = money moved.
   * `"applied_to_balance"` = the whole payout was withheld against
   * lost-dispute debt (no transfer). `"reserved"` = the whole payout was
   * deferred into the rolling reserve (no transfer; the money comes back
   * once the holds mature). In both cases the renderer switches to distinct
   * copy so the payee isn't told "you've been paid" about money that never
   * left.
   */
  kind?: "payout" | "applied_to_balance" | "reserved";
  /** ISO timestamp of when the payout ran. Defaults to the clock's now. */
  payoutDateIso?: string;
  /**
   * The web app origin the payouts link is built from. The link is resolved
   * PER PAYEE here (an ORGANIZATION lands on its admin payouts page; a
   * HUMAN has no such page today and gets no link) — the first real payout
   * shipped one global URL that pointed every payee at the ticket-resale
   * seller page.
   */
  appBaseUrl: string | null;
  /** The SETTLEMENT_CREDIT rows this payout consumed — one email line each. */
  credits: Array<{ entryId: string; orderId: string | null; amountCents: number }>;
  recoveredDebtCents: number;
  connectAccountFeeCents: number;
  reserveHeldCents: number;
  /** Matured reserve returned on this payout (rides the transfer). */
  reserveReleasedCents: number;
};

/** One "where it came from" row of the payout email. */
type PayoutLine = {
  eventTitle: string | null;
  eventStartsAtIso: string | null;
  eventTimezone: string | null;
  ticketCount: number | null;
  amountCents: number;
  orderId: string | null;
};

/**
 * Resolve the recipient humans for a payout item's payee and send each a
 * "you've been paid out" notification (email + in-app).
 *
 * Recipient resolution mirrors the dispute lifecycle notifier:
 * - HUMAN payee  → the human itself.
 * - ORGANIZATION → org members whose role is OWNER / ADMIN / FINANCE, paged
 *   through `repos.organizations.listMembers`.
 *
 * Each recipient gets an explicit idempotencyKey of
 * `payout-completed:${payoutItemId}:${humanId}` so re-runs of the batch (or
 * retries of this helper) never double-send.
 *
 * The payload is enriched ONCE per payout item (not per recipient) with what
 * the email needs to be worth opening: the org's name and payouts page, one
 * line per order (event title, date, ticket count), the balance still owed
 * and when it next matures, and the bank's payout delay. Every one of those
 * reads is best-effort — a failure degrades that field to null/empty, is
 * logged AND reported, and the email still goes out. A payee must never miss
 * "you've been paid" because an event lookup timed out.
 *
 * This helper is best-effort: a failure to notify one recipient is logged and
 * does NOT prevent the others, and the caller must never let a notification
 * failure roll back the (already-executed) payout.
 */
export async function notifyPayoutCompleted(
  deps: NotifyPayoutCompletedDeps,
  args: NotifyPayoutCompletedArgs,
): Promise<void> {
  const payee = await deps.repos.payees.getById(args.payeeId);
  if (!payee) return;

  const recipientHumanIds = await resolveRecipientHumanIds(deps.repos, payee);
  if (recipientHumanIds.length === 0) return;

  const enrichment = await buildEnrichment(deps, args, payee);

  for (const humanId of recipientHumanIds) {
    try {
      await deps.notify({
        humanId,
        variant: NOTIFY_VARIANT,
        idempotencyKey: `payout-completed:${args.payoutItemId}:${humanId}`,
        payload: {
          payeeId: args.payeeId,
          payoutId: args.payoutId,
          payoutItemId: args.payoutItemId,
          amountCents: args.amountCents,
          currency: args.currency,
          settlementCount: args.settlementCount,
          // Only forwarded when explicitly set: the default path must keep
          // producing a payload with no `kind` key at all.
          ...(args.kind ? { kind: args.kind } : {}),
          ...enrichment,
        },
      });
    } catch (error) {
      deps.logger?.error("notifyPayoutCompleted.recipient_notify_failed", {
        payeeId: args.payeeId,
        payoutItemId: args.payoutItemId,
        humanId,
        error: describeError(error),
      });
      // Deliberate swallow (the other recipients must still be notified) —
      // reported explicitly because nothing downstream will see it.
      safeReport(deps, error, {
        tags: { useCase: "notifyPayoutCompleted", step: "recipient_notify" },
        extra: {
          payeeId: args.payeeId,
          payoutItemId: args.payoutItemId,
          humanId,
        },
      });
    }
  }
}

/** What the notifier adds to the payload beyond the bare amounts. */
type Enrichment = {
  payoutDateIso: string;
  orgName: string | null;
  displayTimezone: string;
  lines: PayoutLine[];
  recoveredDebtCents: number;
  connectAccountFeeCents: number;
  reserveHeldCents: number;
  reserveReleasedCents: number;
  otherSalesCount: number;
  otherSalesCents: number;
  balanceAfterCents: number | null;
  nextPayableAtIso: string | null;
  bankDelayDays: number | null;
  stripeDashboardUrl: string;
  payoutsUrl?: string;
};

/**
 * Everything the renderer needs beyond the bare amounts, assembled from
 * best-effort reads under one coarse deadline. Shape mirrors the
 * `settlement.payout_sent` email template's props; the renderer copies it
 * through. On timeout the MINIMAL enrichment goes out instead (amounts and
 * withholdings only — every credit counted as "other sales" so the statement
 * still reconciles), and the timeout is reported.
 */
async function buildEnrichment(
  deps: NotifyPayoutCompletedDeps,
  args: NotifyPayoutCompletedArgs,
  payee: PayeeRecord,
): Promise<Enrichment> {
  const now = deps.clock?.now() ?? new Date();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Cleared in `finally` below, so the deadline never outlives the call.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ENRICHMENT_TIMEOUT_MS);
  });
  try {
    const enriched = await Promise.race([
      enrich(deps, args, payee, now),
      timeout,
    ]);
    if (enriched) return enriched;
  } finally {
    clearTimeout(timer);
  }

  deps.logger?.error("notifyPayoutCompleted.enrichment_timeout", {
    payeeId: payee.id,
    payoutItemId: args.payoutItemId,
    timeoutMs: ENRICHMENT_TIMEOUT_MS,
  });
  safeReport(deps, new Error("notifyPayoutCompleted.enrichment_timeout"), {
    tags: { useCase: "notifyPayoutCompleted", read: "enrichment_timeout" },
    extra: { payeeId: payee.id, payoutItemId: args.payoutItemId },
  });
  return minimalEnrichment(args, now);
}

function minimalEnrichment(
  args: NotifyPayoutCompletedArgs,
  now: Date,
): Enrichment {
  return {
    payoutDateIso: args.payoutDateIso ?? now.toISOString(),
    orgName: null,
    displayTimezone: "UTC",
    lines: [],
    recoveredDebtCents: args.recoveredDebtCents,
    connectAccountFeeCents: args.connectAccountFeeCents,
    reserveHeldCents: args.reserveHeldCents,
    reserveReleasedCents: args.reserveReleasedCents,
    otherSalesCount: args.credits.length,
    otherSalesCents: args.credits.reduce((sum, c) => sum + c.amountCents, 0),
    balanceAfterCents: null,
    nextPayableAtIso: null,
    bankDelayDays: null,
    stripeDashboardUrl: STRIPE_DASHBOARD_URL,
  };
}

async function enrich(
  deps: NotifyPayoutCompletedDeps,
  args: NotifyPayoutCompletedArgs,
  payee: PayeeRecord,
  now: Date,
): Promise<Enrichment> {
  const payoutItemId = args.payoutItemId;
  const currency = args.currency.trim().toLowerCase();

  // A read that returns `fallback` on failure, after logging + reporting.
  const bestEffort = async <T>(
    read: string,
    fallback: T,
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      deps.logger?.error("notifyPayoutCompleted.enrichment_read_failed", {
        read,
        payeeId: payee.id,
        payoutItemId,
        error: describeError(error),
      });
      safeReport(deps, error, {
        tags: { useCase: "notifyPayoutCompleted", read },
        extra: { payeeId: payee.id, payoutItemId },
      });
      return fallback;
    }
  };

  // ── Payee identity + link ──────────────────────────────────────────────
  let orgName: string | null = null;
  let payoutsUrl: string | null = null;
  if (payee.subjectType === "ORGANIZATION") {
    const org = await bestEffort("organization", null, () =>
      deps.repos.organizations.getById(payee.subjectId),
    );
    if (org) {
      orgName = org.name;
      payoutsUrl = args.appBaseUrl
        ? `${args.appBaseUrl.replace(/\/+$/, "")}/admin/${org.slug}/payouts`
        : null;
    }
  }

  // ── Lines: one per consumed credit, largest first when capped ─────────
  // Cap BEFORE the lookups so a 300-order payout costs 25 reads, not 300.
  // The kept rows are then restored to feed order (FIFO by maturity, i.e.
  // roughly chronological) so the list reads like a statement. What the cap
  // drops is NOT lost: it is carried as one "N other sales" total, so the
  // statement's sales still sum to what was paid.
  const ranked = args.credits
    .map((credit, index) => ({ credit, index }))
    .sort((a, b) => b.credit.amountCents - a.credit.amountCents);
  const kept = ranked
    .slice(0, MAX_LINES)
    .sort((a, b) => a.index - b.index)
    .map((r) => r.credit);
  const dropped = ranked.slice(MAX_LINES).map((r) => r.credit);
  const otherSalesCount = dropped.length;
  const otherSalesCents = dropped.reduce((sum, c) => sum + c.amountCents, 0);

  const orderIds = [
    ...new Set(kept.flatMap((c) => (c.orderId ? [c.orderId] : []))),
  ];
  const ordersById = new Map<
    string,
    { eventId: string | null; ticketCount: number }
  >();
  const orders = await mapWithConcurrency(orderIds, LOOKUP_CONCURRENCY, (id) =>
    bestEffort("order", null, () => deps.repos.orders.getById(id)),
  );
  for (const order of orders) {
    if (!order) continue;
    ordersById.set(order.id, {
      eventId: order.eventId,
      // Each OrderItem is one ticket — there is no quantity column.
      ticketCount: order.items.length,
    });
  }

  // An IANA zone the runtime does not know throws in Intl. Probed here (not
  // in the renderer, which has no reporter) so a bad zone on an event is
  // visible in Sentry once, and the line falls back to the display zone.
  const zoneOk = new Map<string, boolean>();
  const probeTimezone = async (timeZone: string): Promise<boolean> => {
    const cached = zoneOk.get(timeZone);
    if (cached !== undefined) return cached;
    const ok = await bestEffort("timezone", false, async () => {
      new Intl.DateTimeFormat("en", { timeZone });
      return true;
    });
    zoneOk.set(timeZone, ok);
    return ok;
  };

  const eventIds = [
    ...new Set(
      [...ordersById.values()].flatMap((o) => (o.eventId ? [o.eventId] : [])),
    ),
  ];
  const eventsById = new Map<
    string,
    { title: string; startsAtIso: string; timezone: string | null }
  >();
  const events = await mapWithConcurrency(eventIds, LOOKUP_CONCURRENCY, (id) =>
    bestEffort("event", null, () => deps.repos.events.getById(id)),
  );
  for (const event of events) {
    if (!event) continue;
    const timezone =
      event.timezone && (await probeTimezone(event.timezone))
        ? event.timezone
        : null;
    eventsById.set(event.id, {
      title: event.title,
      startsAtIso: event.startsAt.toISOString(),
      timezone,
    });
  }

  const lines: PayoutLine[] = kept.map((credit) => {
    const order = credit.orderId ? ordersById.get(credit.orderId) : undefined;
    const event = order?.eventId ? eventsById.get(order.eventId) : undefined;
    return {
      eventTitle: event?.title ?? null,
      eventStartsAtIso: event?.startsAtIso ?? null,
      eventTimezone: event?.timezone ?? null,
      ticketCount: order?.ticketCount ?? null,
      amountCents: credit.amountCents,
      orderId: credit.orderId,
    };
  });

  // Dates in the email are shown in the payee's world, which we approximate
  // with the first event's (already probed) zone. Without one, UTC —
  // honest, if unhelpful.
  const displayTimezone =
    lines.find((l) => l.eventTimezone)?.eventTimezone ?? "UTC";

  // ── Balance still owed, and when it next matures ──────────────────────
  const balanceAfterCents = await bestEffort("balance", null, async () => {
    const balance = await deps.repos.payeeLedger.getBalance(
      payee.id,
      currency,
    );
    return balance.ledgerBalanceCents;
  });

  let nextPayableAtIso: string | null = null;
  if (balanceAfterCents !== null && balanceAfterCents > 0) {
    nextPayableAtIso = await bestEffort("maturities", null, async () => {
      const maturities = await deps.repos.payeeLedger.listUpcomingMaturities(
        now,
        [payee.id],
        { statementTimeoutMs: MATURITY_READ_BUDGET_MS },
      );
      // Ordered `maturesAt` ASC by contract, but filtered by currency here,
      // so take the min rather than trust position.
      let earliest: Date | null = null;
      for (const m of maturities) {
        if (m.payeeId !== payee.id) continue;
        if (m.currency.trim().toLowerCase() !== currency) continue;
        if (!earliest || m.maturesAt < earliest) earliest = m.maturesAt;
      }
      return earliest ? earliest.toISOString() : null;
    });
  }

  // ── Bank timing ───────────────────────────────────────────────────────
  let bankDelayDays: number | null = null;
  if (deps.payments && payee.stripeAccountId) {
    const accountId = payee.stripeAccountId;
    const payments = deps.payments;
    bankDelayDays = await bestEffort("connect_account", null, async () => {
      const status = await payments.getConnectAccountStatus({ accountId });
      return status.payoutSchedule?.delayDays ?? null;
    });
  }

  return {
    payoutDateIso: args.payoutDateIso ?? now.toISOString(),
    orgName,
    displayTimezone,
    lines,
    recoveredDebtCents: args.recoveredDebtCents,
    connectAccountFeeCents: args.connectAccountFeeCents,
    reserveHeldCents: args.reserveHeldCents,
    reserveReleasedCents: args.reserveReleasedCents,
    otherSalesCount,
    otherSalesCents,
    balanceAfterCents,
    nextPayableAtIso,
    bankDelayDays,
    stripeDashboardUrl: STRIPE_DASHBOARD_URL,
    // The renderer schema types this as an optional URL, not nullable —
    // forward it only when there is one.
    ...(payoutsUrl ? { payoutsUrl } : {}),
  };
}

/**
 * `Promise.all` with at most `limit` in flight. Results keep `items`' order.
 * Small enough to not warrant a dependency; the callers wrap each `fn` in
 * `bestEffort`, so a rejection here is a programming error, not a read.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Reporting is best-effort by contract (`ReporterPort`), but the composition
 * roots wire `Sentry.captureException` raw — so guard here too: reporting a
 * swallowed failure must never manufacture a new one that blocks the email.
 */
function safeReport(
  deps: NotifyPayoutCompletedDeps,
  error: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    deps.reportError?.(error, context);
  } catch {
    // Intentionally empty — see the doc comment.
  }
}

async function resolveRecipientHumanIds(
  repos: Repos,
  payee: PayeeRecord,
): Promise<string[]> {
  if (payee.subjectType === "HUMAN") {
    return [payee.subjectId];
  }

  return resolveOrgRecipientHumanIds(repos, payee.subjectId);
}

async function resolveOrgRecipientHumanIds(
  repos: Repos,
  orgId: string,
): Promise<string[]> {
  const humanIds = new Set<string>();
  const limit = 100;
  let offset = 0;
  let total = 0;

  do {
    const page = await repos.organizations.listMembers({ orgId, limit, offset });
    total = page.total;

    for (const member of page.items) {
      if (!PAYOUT_NOTIFY_ORG_ROLES.has(member.role)) continue;
      humanIds.add(member.humanId);
    }

    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);

  return [...humanIds];
}
