import type { Prisma } from "@prisma/client";

import { fail } from "@th/errors";

import type { PrismaClientOrTx } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// A Postgres statement budget for INTERACTIVE staff reads.
//
// Why a budget at all: a staff page that issues an unbounded query hangs the
// page rather than failing it, and a hung panel is indistinguishable from a
// broken one. With a budget the query is cancelled and the adapter — the only
// layer that can see driver codes — maps the cancellation to
// SERVICE_UNAVAILABLE, which the UI renders as "timed out, try again".
//
// TWO BUDGETS, ORDERED ON PURPOSE. Prisma's interactive transaction has its
// OWN `timeout` (default 5000ms); a statement that outlives it is killed by
// PRISMA (P2028 "Transaction already closed"), not by Postgres, so any
// `SET LOCAL statement_timeout` above 5s inside a default transaction is
// unreachable. The transaction budget is therefore set ABOVE the statement's,
// so POSTGRES cancels first and the error carries 57014. Both are classified,
// so the degrade path holds even if the ordering ever regresses.
//
// A TransactionClient is REFUSED. `SET LOCAL` on a caller's `repos.tx` would
// silently apply the timeout to everything else in that transaction, which is
// a budget nobody asked for applied to writes nobody wants cancelled.
//
// NOT A MIGRATION. `payee-ledger.ts` and `payout-items.ts` grew their own
// copies of this before it existed and are deliberately left alone here: they
// are the hottest money-read paths in the codebase and moving them is its own
// change with its own integration run. This is the shared version new callers
// use.
// ─────────────────────────────────────────────────────────────────────────────

type PrismaWithTransaction = PrismaClientOrTx & {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
};

function hasTransaction(p: PrismaClientOrTx): p is PrismaWithTransaction {
  return typeof (p as { $transaction?: unknown }).$transaction === "function";
}

/** Hard ceiling on a caller-supplied statement timeout (5 minutes). */
const MAX_STATEMENT_TIMEOUT_MS = 300_000;
/** Interactive-tx `timeout` = statement budget + this, so Postgres fires first. */
export const STATEMENT_BUDGET_TX_HEADROOM_MS = 2_000;
/** Interactive-tx `maxWait` (time to acquire a connection from the pool). */
export const STATEMENT_BUDGET_TX_MAX_WAIT_MS = 5_000;

/**
 * Walks the cause chain looking for either cancellation. Returns null when the
 * error is something else entirely, which must propagate untouched — a
 * constraint violation dressed up as SERVICE_UNAVAILABLE would send an
 * operator looking at the database's load instead of at their own data.
 */
export function classifyStatementTimeout(
  err: unknown,
): "statement" | "transaction" | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as {
      code?: unknown;
      meta?: { code?: unknown };
      message?: unknown;
      cause?: unknown;
    };
    if (o.code === "57014" || o.meta?.code === "57014") return "statement";
    if (o.code === "P2028") return "transaction";
    if (typeof o.message === "string") {
      if (/statement timeout|57014/i.test(o.message)) return "statement";
      if (
        /transaction already closed|expired transaction|P2028/i.test(o.message)
      ) {
        return "transaction";
      }
    }
    cur = o.cause;
  }
  return null;
}

/**
 * Test-only seam: an async hook run INSIDE the budgeted transaction, after the
 * SET LOCALs and before the statement. Integration tests use it to make a read
 * slow for real (`SELECT pg_sleep(...)`) and prove which budget fires. Never
 * set in production code paths.
 */
export const __testOnlyStatementBudgetHooks: {
  beforeQuery: ((tx: PrismaClientOrTx) => Promise<void>) | null;
} = { beforeQuery: null };

/**
 * Run `fn` under a Postgres statement budget.
 *
 * An OMITTED or non-finite `statementTimeoutMs` short-circuits to the bare
 * call: same bytes, same transaction (none), same errors. Headless callers
 * (jobs) must keep behaving exactly as they did before a budget existed.
 */
export async function withStatementBudget<T>(
  p: PrismaClientOrTx,
  statementTimeoutMs: number | undefined,
  label: string,
  fn: (client: PrismaClientOrTx) => Promise<T>,
): Promise<T> {
  if (statementTimeoutMs == null || !Number.isFinite(statementTimeoutMs)) {
    return fn(p);
  }

  const timeoutMs = Math.min(
    Math.max(Math.floor(statementTimeoutMs), 1),
    MAX_STATEMENT_TIMEOUT_MS,
  );
  const txTimeoutMs = timeoutMs + STATEMENT_BUDGET_TX_HEADROOM_MS;

  if (!hasTransaction(p)) {
    throw fail("INTERNAL", {
      message: `${label}_requires_top_level_client`,
      meta: {
        hint: `${label} with a statement budget must run outside repos.tx`,
      },
    });
  }

  try {
    // Invoke as a METHOD — destructuring `$transaction` off the client loses
    // its `this` binding and throws "_engineConfig of undefined" on a real
    // PrismaClient.
    return await (p as PrismaWithTransaction).$transaction(
      async (tx: Prisma.TransactionClient) => {
        // SET cannot take a bind parameter; `timeoutMs` is an integer this
        // function clamped, never caller text, so the interpolation is a
        // number literal by construction.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        if (__testOnlyStatementBudgetHooks.beforeQuery) {
          await __testOnlyStatementBudgetHooks.beforeQuery(tx);
        }
        return fn(tx);
      },
      {
        maxWait: STATEMENT_BUDGET_TX_MAX_WAIT_MS,
        timeout: txTimeoutMs,
      },
    );
  } catch (err) {
    const expired = classifyStatementTimeout(err);
    if (expired) {
      throw fail("SERVICE_UNAVAILABLE", {
        message: `${label}_timeout`,
        meta: {
          expired,
          statementTimeoutMs: timeoutMs,
          transactionTimeoutMs: txTimeoutMs,
        },
        cause: err,
      });
    }
    throw err;
  }
}
