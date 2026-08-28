/**
 * test-payout-notification.ts — Watch the payout-completed notification fire
 * end-to-end against your LOCAL dev stack, on demand and repeatably.
 *
 * What it does:
 *   1. Builds the REAL jobs container (real repos / mailer→Mailpit
 *      / idempotency / clock / appBaseUrl).
 *   2. Overrides ONLY `payments.createTransfer` with a fake so the Stripe
 *      transfer deterministically succeeds without touching Stripe.
 *   3. Fabricates one MATURED `SETTLEMENT_CREDIT` ledger entry for the demo
 *      payee (synthetic orderId, empty item attribution — nothing to block it,
 *      nothing to classify, so no reserve and no Connect fee apply).
 *   4. Runs the EXACT production `settlements.run-batch` job handler, which wires
 *      the real `notifyPayoutCompleted` → `notify` path (email + in-app).
 *   5. Reports who should have been notified (recipient humans + emails), prints
 *      the Notification rows that were created, and points you at Mailpit.
 *
 * The ONLY fakes are the inserted ledger credit and the createTransfer result.
 * Both are logged loudly. The fabricated credit — and the PAYOUT entry the batch
 * writes against it — are DELETED in a finally block after the run (regardless
 * of outcome), with the cached balance rollup restored to its pre-run value, so
 * the dev DB is never polluted. Pass `--keep-settlement` to opt out and inspect
 * the rows.
 *
 * Prerequisites (local dev):
 *   - Local Postgres seeded: `pnpm seed:dev` (creates the demo org/payee/agreement).
 *   - Local Redis running (idempotency).
 *   - Mailpit running (SMTP :1025, web UI http://localhost:8025) and the jobs
 *     SMTP_* env pointed at it. The container mailer uses
 *     `blockReservedTestDomains: true`, so a deliverable recipient
 *     (admin@ithasfire.com) is required for the email path to actually send.
 *   - apps/jobs env loaded (.env / .env.local with DATABASE_URL, REDIS_URL, SMTP_*).
 *
 * Usage:
 *   pnpm -F jobs test:payout-notification
 *   pnpm -F jobs test:payout-notification -- --amount 5000
 *   pnpm -F jobs test:payout-notification -- --payee <uuid> --limit 50
 *   pnpm -F jobs test:payout-notification -- --keep-settlement  # skip cleanup
 *   pnpm -F jobs test:payout-notification -- --force   # bypass the prod/host guard
 *
 * DEV TOOLING ONLY — refuses to run against production (NODE_ENV=production or a
 * non-local DATABASE_URL host) unless `--force` is passed.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

import { getPrisma } from "@th/db";
import { isReservedTestEmail } from "@th/adapters/comms/mail";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { LoggerPort } from "@th/ports/logger";

import { buildContainer } from "../lib/container";
import { runBatch } from "../jobs/settlements";

// Deterministic seed IDs (mirrors apps/api/src/scripts/seed/ids.ts). Kept inline
// so this dev script doesn't reach across into the API package's src tree.
const DEMO_PAYEE_ID = "00000000-0000-4000-8000-00000000d002";
const DEMO_AGREEMENT_ID = "00000000-0000-4000-8000-00000000d003";

// ── CLI args ─────────────────────────────────────────────────────────────────
const USAGE = `Usage:
  pnpm -F jobs test:payout-notification
  pnpm -F jobs test:payout-notification -- --amount 5000
  pnpm -F jobs test:payout-notification -- --payee <uuid> --limit 50
  pnpm -F jobs test:payout-notification -- --keep-settlement
  pnpm -F jobs test:payout-notification -- --force

Options:
  --amount <cents>     Amount of the fabricated due settlement (default 2500).
  --payee <uuid>       Payee to fabricate the settlement for (default demo payee).
  --limit <n>          Batch limit, 1..500 (default 100).
  --keep-settlement    Do NOT delete the fabricated ledger credit after the run
                       (for inspecting the rows). DANGEROUS in a shared dev DB:
                       a later real run-batch may pay out a leftover credit.
  --force              Bypass the prod/non-local DB guard (use with care).`;

let values: {
  amount?: string;
  payee?: string;
  limit?: string;
  "keep-settlement"?: boolean;
  force?: boolean;
};
try {
  ({ values } = parseArgs({
    options: {
      amount: { type: "string", default: "2500" },
      payee: { type: "string", default: DEMO_PAYEE_ID },
      limit: { type: "string", default: "100" },
      "keep-settlement": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    // strict: an unknown/typo'd flag (e.g. --amout) errors instead of silently
    // falling back to the default. No positionals are expected.
    strict: true,
    allowPositionals: false,
  }));
} catch (err) {
  console.error(
    `[payout-test] ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(`\n${USAGE}`);
  process.exit(1);
}

const amountCents = Number.parseInt(values.amount ?? "2500", 10);
const payeeId = values.payee ?? DEMO_PAYEE_ID;
const limit = Number.parseInt(values.limit ?? "100", 10);
const force = values.force === true;
const keepSettlement = values["keep-settlement"] === true;

if (!Number.isFinite(amountCents) || amountCents < 1) {
  console.error("[payout-test] --amount must be a positive integer (cents).");
  process.exit(1);
}
if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
  console.error("[payout-test] --limit must be an integer between 1 and 500.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    "[payout-test] DATABASE_URL is not set. Put it in apps/jobs/.env.local or pass it as an env var.",
  );
  process.exit(1);
}

// ── Prod / non-local guard ─────────────────────────────────────────────────────
// Be conservative: only run when this is clearly a local/dev DB, unless --force.
function isLocalDbHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "host.docker.internal" ||
    h === "postgres" || // common docker-compose service name
    h === "db" ||
    h.endsWith(".local")
  );
}

let dbHost = "(unparseable)";
try {
  dbHost = new URL(process.env.DATABASE_URL).hostname;
} catch {
  // leave as unparseable
}
console.log(`[payout-test] Target database host: ${dbHost}`);

const looksProd =
  process.env.NODE_ENV === "production" || !isLocalDbHost(dbHost);
if (looksProd && !force) {
  console.error(
    `[payout-test] Refusing to run: this looks like a non-local / production target ` +
      `(NODE_ENV=${process.env.NODE_ENV ?? "unset"}, db host="${dbHost}"). ` +
      `This is dev tooling only. Pass --force ONLY if you are certain this is a dev DB.`,
  );
  process.exit(1);
}
if (looksProd && force) {
  console.warn(
    "[payout-test] ⚠️  --force given: bypassing the prod/host guard. Proceeding anyway.",
  );
}

// A standalone Prisma client for the read-only reporting queries (recipients,
// emails, Notification rows). The container does not expose its Prisma handle,
// so we use the shared @th/db singleton (same DATABASE_URL).
const prisma = getPrisma();

/** Fallback minimum when no GLOBAL FeePolicy exists (mirrors run-batch). */
const DEFAULT_PAYOUT_MINIMUM_CENTS = 1000;

async function main() {
  const startedAtMs = Date.now();

  const container = await buildContainer();
  const logger: LoggerPort = container.logger;

  // Tracks the fabricated ledger credit so the finally block can remove it
  // (and the PAYOUT entry written against it) regardless of the batch
  // outcome (success, failure, skip, or throw).
  let fabricatedCreditKey: string | null = null;
  let balanceBeforeCents: number | null = null;

  try {
    // ── 1. Verify the seeded payee exists ─────────────────────────────────────
    const payee = await container.repos.payees.getById(payeeId);
    if (!payee) {
      console.error(
        `[payout-test] Payee ${payeeId} not found. Run \`pnpm seed:dev\` first ` +
          `(or pass --payee <uuid> for an existing payee).`,
      );
      process.exit(1);
    }
    console.log(
      `[payout-test] Payee ${payee.id}: subjectType=${payee.subjectType} ` +
        `subjectId=${payee.subjectId} payoutsEnabled=${payee.payoutsEnabled} ` +
        `stripeAccountId=${payee.stripeAccountId ?? "(none)"}`,
    );
    if (!payee.stripeAccountId) {
      console.warn(
        "[payout-test] ⚠️  Payee has no stripeAccountId — the batch will mark the " +
          "item failed before transfer and NO notification will fire. Seed a payee " +
          "with a stripe account (the demo payee has one).",
      );
    }

    // ── 2. Fake the Stripe transfer (loud) ────────────────────────────────────
    // Spread the real payments port so the type stays honest; override ONLY
    // createTransfer, which is the single method run-batch exercises.
    const fakePayments: PaymentProcessorPort = {
      ...container.payments,
      createTransfer: async (input) => {
        const fakeId = `tr_test_${Date.now()}`;
        console.log(
          `[payout-test] 🧪 FAKED Stripe transfer → id=${fakeId} ` +
            `amountCents=${input.amountCents} currency=${input.currency} ` +
            `destination=${input.destinationAccountId} (Stripe NOT contacted)`,
        );
        return { id: fakeId };
      },
    };

    const now = container.clock.now();

    // ── 2b. Resolve the EFFECTIVE payout minimum (same source as run-batch) ───
    // run-batch reads payoutMinimumCents off the GLOBAL FeePolicy, falling back
    // to $10 when none exists. If --amount is below the resolved minimum the
    // batch silently skips the group (itemsSkippedBelowMinimum) and NO
    // notification fires — so warn loudly up front rather than after the fact.
    const globalPolicy = await container.repos.feePolicies.resolveEffective({
      scopeType: "GLOBAL",
      scopeId: null,
      at: now,
    });
    const payoutMinimumCents =
      globalPolicy?.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS;
    console.log(
      `[payout-test] Effective payout minimum: ${payoutMinimumCents} cents ` +
        `(source: ${globalPolicy ? "GLOBAL FeePolicy" : "default fallback"}).`,
    );
    if (amountCents < payoutMinimumCents) {
      console.warn(
        `[payout-test] ⚠️  --amount (${amountCents}) is BELOW the effective payout ` +
          `minimum (${payoutMinimumCents}). The batch will skip this group as ` +
          `below-minimum and NO notification will fire. Re-run with ` +
          `--amount ${payoutMinimumCents} (or higher) to drive the notification.`,
      );
    }

    // ── 3. Fabricate a MATURED ledger credit (loud) ───────────────────────────
    // Revenue is a SETTLEMENT_CREDIT now; `availableAt` in the past is what
    // makes it payable this instant. The synthetic orderId matches no Order
    // row, so the payable query's dispute/claim exclusions cannot fire and
    // `orders.getKindsByIds` classifies it as neither ticketing nor
    // membership — no reserve, no Connect fee, just a clean transfer.
    const availableAt = new Date(now.getTime() - 60_000); // 1 min ago → matured
    const syntheticOrderId = `payout-test-${randomUUID()}`;
    const creditKey = `settlement-credit:${syntheticOrderId}:${payee.id}`;
    // Snapshot the cached rollup so cleanup can restore it exactly.
    const balanceRow = await prisma.payeeLedgerBalance.findUnique({
      where: { payeeId_currency: { payeeId: payee.id, currency: "usd" } },
      select: { ledgerBalanceCents: true },
    });
    balanceBeforeCents = balanceRow?.ledgerBalanceCents ?? 0;
    const credit = await container.repos.payeeLedger.settlementCredit({
      idempotencyKey: creditKey,
      payeeId: payee.id,
      amountCents,
      currency: "usd",
      orderId: syntheticOrderId,
      availableAt,
      description: "payout-test fabricated revenue",
      // Empty attribution: no real order items exist, so the batch has
      // nothing to stamp `paidOutAt` on.
      metadata: { items: {} },
      sourceKind: "payout_test",
      sourceId: syntheticOrderId,
    });
    fabricatedCreditKey = creditKey;
    console.log(
      `[payout-test] 🧪 FABRICATED matured SETTLEMENT_CREDIT id=${credit.id} ` +
        `amountCents=${amountCents} currency=usd availableAt=` +
        `${availableAt.toISOString()} orderId=${syntheticOrderId} ` +
        `(agreement ${DEMO_AGREEMENT_ID} is not referenced — maturity is on the entry)`,
    );

    // ── 4. Resolve who SHOULD be notified (mirrors notify-payout-completed) ───
    const recipients = await resolveRecipients(container.repos, payee.id);
    if (recipients.length === 0) {
      console.warn(
        "[payout-test] ⚠️  Resolved 0 recipients for this payee. For an ORG payee " +
          "you need members with OWNER/ADMIN/FINANCE roles; for a HUMAN payee the " +
          "human must exist. No notification will be delivered.",
      );
    } else {
      console.log("[payout-test] Expected recipients:");
      for (const r of recipients) {
        const reserved = r.email ? isReservedTestEmail(r.email) : false;
        console.log(
          `  • humanId=${r.humanId} email=${r.email ?? "(none)"}` +
            (reserved ? "  [reserved test domain]" : ""),
        );
        if (reserved) {
          console.warn(
            `    ⚠️  ${r.email} is a reserved test domain. Local Mailpit may still ` +
              "receive it, but dev/prod Resend would SKIP it (blockReservedTestDomains).",
          );
        }
      }
    }

    // ── 5. Run the REAL run-batch handler (production notify wiring) ───────────
    const runId = randomUUID();
    console.log(
      `[payout-test] Running settlements.run-batch (runId=${runId}, limit=${limit})…`,
    );
    const result = await runBatch.handler({
      input: { limit },
      // Mirror app.ts: ctx = { ...container, logger, runId } — but with the
      // faked payments overriding the real one.
      ctx: { ...container, payments: fakePayments, logger, runId },
    });

    console.log("[payout-test] Batch result:");
    console.log(`  payoutId:                 ${result.payoutId ?? "none"}`);
    console.log(`  itemsCreated:             ${result.itemsCreated}`);
    console.log(`  itemsTransferred:         ${result.itemsTransferred}`);
    console.log(`  itemsSkippedBelowMinimum: ${result.itemsSkippedBelowMinimum}`);
    console.log(`  itemsSkippedIneligible:   ${result.itemsSkippedIneligible}`);
    console.log(
      `  itemsSkippedPayableDropped: ${result.itemsSkippedPayableDropped}`,
    );
    console.log(`  itemsHeldForSuspension:   ${result.itemsHeldForSuspension}`);
    console.log(`  itemsFailed:              ${result.itemsFailed}`);
    console.log(`  totalTransferredCents:    ${result.totalTransferredCents}`);
    console.log(
      `  totalPayableClaimedCents: ${result.totalPayableClaimedCents}`,
    );

    if (result.itemsTransferred === 0) {
      console.warn(
        "[payout-test] ⚠️  No items transferred — the notification path was NOT " +
          "reached. Check the skip/fail counts above (e.g. below-minimum, a " +
          "payee without a stripe account, or an existing NEGATIVE payable " +
          "balance for this payee that swallowed the fabricated credit).",
      );
    }

    // ── 6. Report the Notification rows that were created ─────────────────────
    const humanIds = recipients.map((r) => r.humanId);
    const sinceMs = Math.min(startedAtMs, now.getTime()) - 2 * 60_000;
    const notifications =
      humanIds.length > 0
        ? await prisma.notification.findMany({
            where: {
              humanId: { in: humanIds },
              createdAt: { gte: new Date(sinceMs) },
            },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              humanId: true,
              title: true,
              body: true,
              createdAt: true,
            },
          })
        : [];

    if (notifications.length > 0) {
      console.log(
        `[payout-test] Notification rows created (last ~2 min, ${notifications.length}):`,
      );
      for (const n of notifications) {
        console.log(
          `  • id=${n.id} humanId=${n.humanId} createdAt=${n.createdAt.toISOString()}`,
        );
        console.log(`    title: ${n.title ?? "(none)"}`);
        console.log(`    body:  ${n.body}`);
      }
    } else {
      console.log(
        "[payout-test] No matching Notification rows found for the resolved recipients.",
      );
    }

    // ── 7. Where to look ──────────────────────────────────────────────────────
    console.log("");
    console.log("📧 Email:  open Mailpit at http://localhost:8025");
    console.log(
      `🔔 In-app: ${notifications.length} Notification row(s) created (see above); ` +
        "recipients see them in their polled inbox",
    );
    console.log("");
    console.log("[payout-test] Done.");
  } finally {
    // ── Cleanup: remove the fabricated ledger rows ──────────────────────────
    // The credit exists ONLY to drive the notification; by here it has already
    // fired (or been observed to skip/fail), and the Notification rows +
    // Mailpit email persist independently of it.
    //
    // Two rows can exist: the fabricated SETTLEMENT_CREDIT and — on the
    // success path — the PAYOUT entry the batch wrote against it. Both are
    // deleted, then the cached `PayeeLedgerBalance.ledgerBalanceCents` is
    // restored to the value snapshotted before the run, so the rollup and the
    // entries agree again whichever path the batch took. Leftover Payout /
    // PayoutItem rows are inert (nothing re-sweeps them) and are left in
    // place with their ids noted.
    if (fabricatedCreditKey) {
      if (keepSettlement) {
        console.warn(
          `[payout-test] ⚠️  --keep-settlement: leaving fabricated ledger rows ` +
            `for key=${fabricatedCreditKey} in the DB. A LATER real local ` +
            `settlements.run-batch may pay the credit out if it is still ` +
            `unconsumed. To remove it manually:\n` +
            `    DELETE FROM "PayeeLedgerEntry" WHERE "idempotencyKey" = '${fabricatedCreditKey}';`,
        );
      } else {
        try {
          const creditRow = await prisma.payeeLedgerEntry.findUnique({
            where: { idempotencyKey: fabricatedCreditKey },
            select: { id: true, consumedByEntryId: true },
          });
          const payoutEntryId = creditRow?.consumedByEntryId ?? null;
          await prisma.payeeLedgerEntry.deleteMany({
            where: {
              id: {
                in: [creditRow?.id, payoutEntryId].filter(
                  (id): id is string => id != null,
                ),
              },
            },
          });
          if (balanceBeforeCents != null) {
            await prisma.payeeLedgerBalance.updateMany({
              where: { payeeId, currency: "usd" },
              data: { ledgerBalanceCents: balanceBeforeCents },
            });
          }
          console.log(
            `[payout-test] 🧹 Cleaned up fabricated ledger rows ` +
              `(credit=${creditRow?.id ?? "?"}, payoutEntry=${payoutEntryId ?? "none"}) ` +
              `and restored ledgerBalanceCents to ${balanceBeforeCents}. ` +
              `Payout/PayoutItem rows (if created) are inert and left in place.`,
          );
        } catch (err) {
          console.error(
            `[payout-test] ⚠️  FAILED to clean up fabricated ledger rows for ` +
              `key=${fabricatedCreditKey}: ` +
              `${err instanceof Error ? err.message : String(err)}\n` +
              `    Remove them manually so a later run-batch doesn't pay them out:\n` +
              `    DELETE FROM "PayeeLedgerEntry" WHERE "idempotencyKey" = '${fabricatedCreditKey}';`,
          );
        }
      }
    }

    await container.close().catch((err) => {
      logger.error("payout-test.container_close_failed", { err });
    });
  }
}

// ── Recipient resolution (mirrors notify-payout-completed.ts) ──────────────────
type Recipient = { humanId: string; email: string | null };

const PAYOUT_NOTIFY_ORG_ROLES = new Set(["OWNER", "ADMIN", "FINANCE"]);

async function resolveRecipients(
  repos: Awaited<ReturnType<typeof buildContainer>>["repos"],
  resolvedPayeeId: string,
): Promise<Recipient[]> {
  const payee = await repos.payees.getById(resolvedPayeeId);
  if (!payee) return [];

  if (payee.subjectType === "HUMAN") {
    return [{ humanId: payee.subjectId, email: await emailForHuman(payee.subjectId) }];
  }

  // ORGANIZATION: members with OWNER/ADMIN/FINANCE roles, paged.
  const humanIds = new Set<string>();
  const pageSize = 100;
  let offset = 0;
  let total = 0;
  do {
    const page = await repos.organizations.listMembers({
      orgId: payee.subjectId,
      limit: pageSize,
      offset,
    });
    total = page.total;
    for (const member of page.items) {
      if (PAYOUT_NOTIFY_ORG_ROLES.has(member.role)) {
        humanIds.add(member.humanId);
      }
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);

  const recipients: Recipient[] = [];
  for (const humanId of humanIds) {
    recipients.push({ humanId, email: await emailForHuman(humanId) });
  }
  return recipients;
}

/** Best-effort lookup of a human's primary auth email for display. */
async function emailForHuman(humanId: string): Promise<string | null> {
  const authUser = await prisma.authUser.findFirst({
    where: { humanId },
    select: { email: true },
    orderBy: { createdAt: "asc" },
  });
  return authUser?.email ?? null;
}

main()
  .catch((err) => {
    console.error("[payout-test] Fatal:", err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
