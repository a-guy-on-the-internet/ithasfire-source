import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  PayeeStatus,
  SyncPayeeCapabilitiesOutcome,
} from "@th/ports/repos/payees";

/**
 * Single source of truth for "is this connected account able to sell and get
 * paid?".
 *
 * Historically two surfaces answered that question from two different systems
 * and nothing reconciled them:
 *
 *   - the Payments settings page read LIVE Stripe (`accounts.retrieve`) and
 *     showed `charges_enabled` / `payouts_enabled`;
 *   - the publish gate read our `Payee` row, which could only ever be written
 *     by the `account.updated` webhook, derived from `capabilities`.
 *
 * A single missed, mis-parsed or out-of-order `account.updated` therefore left
 * the row permanently stale, and the organizer saw a green Payments page while
 * publish refused with STRIPE_NOT_CONNECTED_OWNER. This use case is now the
 * ONLY way capability state is derived, and both the webhook and the live read
 * funnel through it, so the two surfaces cannot disagree about semantics.
 *
 * The one case still NOT self-healed is a RESTRICTED payee — see the
 * `skipped_restricted` branch below.
 *
 * Field precedence:
 *
 *  - `charges_enabled` / `payouts_enabled` are Stripe's own roll-up of the
 *    capabilities *plus* outstanding requirements, and they are exactly what
 *    the Payments page renders, so they lead. Capabilities are the fallback for
 *    payloads that omit them.
 *  - EXCEPT `transfers`, which is ANDed in rather than overridden. See the long
 *    comment in `deriveConnectCapabilities` — `payoutsEnabled` is both the
 *    publish gate and the only precondition before a destination transfer, and
 *    those two questions have different answers.
 *
 * Both surfaces must call this with the SAME inputs, which is why
 * `PaymentProcessorPort.getConnectAccountStatus` also carries `capabilities`.
 * If the live read stopped passing them, it would silently become the more
 * permissive of the two paths and (being the newer observation) always win.
 */

export type ConnectAccountCapabilities = {
  /**
   * Stripe capability status strings. Deliberately typed as `string` and not
   * an enum: Stripe ships values beyond active/pending/inactive (e.g.
   * `unrequested`, `provisioning`, `disabled`) and an over-narrow enum turned
   * an unknown value into a dropped webhook (see `AccountUpdatedZ`).
   */
  transfers?: string | null;
  card_payments?: string | null;
};

export type ConnectAccountSnapshot = {
  stripeAccountId: string;
  /** Account-level `charges_enabled`. `null`/absent falls back to capabilities. */
  chargesEnabled?: boolean | null;
  /** Account-level `payouts_enabled`. `null`/absent falls back to capabilities. */
  payoutsEnabled?: boolean | null;
  capabilities?: ConnectAccountCapabilities | null;
  defaultCurrency?: string | null;
  requirements?: unknown;
};

export type SyncConnectAccountInput = {
  account: ConnectAccountSnapshot;
  /**
   * When this snapshot was true at the source. For webhooks this is the Stripe
   * `event.created` timestamp; for a live read it is "now". Used as the
   * ordering guard so a late-arriving retry of an older event can never clobber
   * a newer write (Stripe does not guarantee delivery order).
   */
  observedAt: Date;
  source: "webhook" | "live-read";
  /**
   * Dev-only escape hatch. Seeded Stripe Custom accounts never complete
   * onboarding, so Stripe reports their capabilities as inactive and every
   * seeded paid event would become unsellable seconds after `pnpm seed:dev`.
   * The composition root passes `true` outside production. Production MUST
   * always pass `false`/omit — see `forceConnectCapabilities` in
   * `apps/api/src/lib/env.ts`.
   */
  forceEnabled?: boolean;
};

export type SyncConnectAccountResult = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  status: PayeeStatus;
  forced: boolean;
  /**
   * What the repo actually did. A `skipped_*` outcome means the derived values
   * above were NOT persisted — do not treat this result as proof of a write.
   */
  outcome: SyncPayeeCapabilitiesOutcome;
};

export type SyncConnectAccountDeps = {
  repos: Repos;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Pure derivation — no I/O. Exported so both the webhook path and the
 * live-read path can be asserted against the *same* function in tests.
 */
export function deriveConnectCapabilities(
  account: ConnectAccountSnapshot,
  forceEnabled = false,
): Omit<SyncConnectAccountResult, "forced" | "outcome"> {
  if (forceEnabled) {
    return { chargesEnabled: true, payoutsEnabled: true, status: "ACTIVE" };
  }

  const cardPaymentsActive = account.capabilities?.card_payments === "active";
  const transfersActive = account.capabilities?.transfers === "active";

  const chargesEnabled = account.chargesEnabled ?? cardPaymentsActive;

  // `payouts_enabled` alone is NOT sufficient to decide we can pay this account.
  // It answers "can Stripe pay out this account's balance to its bank?", which
  // is a different question from "can WE move money to it?" — a destination
  // transfer additionally requires the `transfers` capability to be active.
  // `Payee.payoutsEnabled` is the only local precondition before
  // `createTransfer` (settlements/run-batch.ts)
  // AND it is the publish gate, so deriving it from the account-level flag
  // alone would let a paid event publish and sell, then fail at settlement with
  // "destination account needs the transfers capability" — organizer holding
  // sold inventory and no payout.
  //
  // When we have no capability information at all (a stub/e2e processor, or a
  // payload that omits it) we do not invent a restriction: `transfersUsable`
  // stays true and the account-level flag decides.
  const transfersUsable = account.capabilities ? transfersActive : true;

  const payoutsEnabled =
    (account.payoutsEnabled ?? (cardPaymentsActive && transfersActive)) &&
    transfersUsable;

  // Only ever PENDING <-> ACTIVE here. RESTRICTED is owned exclusively by the
  // deauthorize handler and is enforced again in the repo's conditional write.
  const status: PayeeStatus =
    chargesEnabled && payoutsEnabled ? "ACTIVE" : "PENDING";

  return { chargesEnabled, payoutsEnabled, status };
}

export async function syncConnectAccount(
  deps: SyncConnectAccountDeps,
  input: SyncConnectAccountInput,
): Promise<SyncConnectAccountResult> {
  const { account, observedAt, source } = input;
  const forced = input.forceEnabled === true;
  const derived = deriveConnectCapabilities(account, forced);

  const outcome = await deps.repos.payees.syncCapabilities({
    stripeAccountId: account.stripeAccountId,
    status: derived.status,
    payoutsEnabled: derived.payoutsEnabled,
    chargesEnabled: derived.chargesEnabled,
    defaultCurrency: account.defaultCurrency ?? "usd",
    requirements: account.requirements ?? null,
    observedAt,
  });

  const logFields = {
    stripeAccountId: account.stripeAccountId,
    source,
    outcome,
    status: derived.status,
    chargesEnabled: derived.chargesEnabled,
    payoutsEnabled: derived.payoutsEnabled,
    forced,
    observedAt: observedAt.toISOString(),
  };

  // NOTE on why these escalations report explicitly rather than relying on
  // `logger.error`: the API bridges pino -> Sentry (`Sentry.pinoIntegration`
  // in apps/api/src/instrument.ts), but apps/jobs does NOT. Since the reconcile
  // sweep calls this from the jobs process, an error-level line alone would
  // reach Cloud Logging and nothing else — invisible in exactly the process
  // that touches every payee on the platform.
  if (outcome === "skipped_no_account") {
    // A caller reached us with no account id at all. Not a Stripe condition —
    // a bug on our side, and it would otherwise hide in the routine branch.
    deps.logger?.error("stripe_connect_account_sync_no_account_id", logFields);
    reportSyncIssue(
      deps,
      new Error("syncConnectAccount called with no Stripe account id"),
      logFields,
    );
  } else if (outcome === "skipped_restricted") {
    // Not routine, and NOT self-healing: a RESTRICTED payee is never promoted
    // by either the webhook or the live-read write-back, so an account that was
    // deauthorized and then re-onboarded is permanently unable to publish or be
    // paid — the original outage, reached by a different route. `logger.error`
    // (Sentry-captured) rather than warn, because nothing else would surface it.
    const fields = {
      ...logFields,
      hint: "Payee is RESTRICTED (deauthorized). Re-onboarding does not clear it — the status must be reset deliberately.",
    };
    deps.logger?.error(
      "stripe_connect_account_sync_skipped_restricted",
      fields,
    );
    reportSyncIssue(
      deps,
      new Error(
        `Connect sync refused: payee for ${account.stripeAccountId} is RESTRICTED and cannot be promoted`,
      ),
      fields,
    );
  } else if (outcome === "skipped_unknown_account") {
    // No Payee row for this account: foreign. Routine in dev — every
    // `stripe trigger account.updated` mints a brand-new account — and
    // possible in prod for accounts outlived by their rows. Nothing to heal,
    // and neither a retry nor a replay could do better (the repo deliberately
    // no longer mints placeholder rows here; see the outcome's doc in
    // @th/types). Visible, not alarming: info, no DLQ, no Sentry.
    deps.logger?.info("stripe_connect_account_sync_unknown_account", logFields);
  } else if (outcome === "skipped_stale") {
    // Expected and healthy: a late/duplicate delivery losing the ordering guard.
    deps.logger?.info("stripe_connect_account_sync_skipped_stale", logFields);
  } else {
    deps.logger?.info("stripe_connect_account_synced", logFields);
  }

  return { ...derived, forced, outcome };
}

/** Best-effort report; a throwing reporter must never change behaviour. */
function reportSyncIssue(
  deps: SyncConnectAccountDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { area: "stripe-connect", op: "sync-connect-account" },
      extra,
    });
  } catch {
    // Intentionally empty.
  }
}

/**
 * Best-effort variant used by read paths (e.g. the Payments settings page).
 *
 * The read must still succeed if the write-back fails, so this never throws —
 * but a swallowed failure is reported via `ReporterPort` per the repo's error
 * convention, because a silently-failing write-back would quietly restore the
 * exact divergence this function exists to remove.
 */
export async function syncConnectAccountBestEffort(
  deps: SyncConnectAccountDeps,
  input: SyncConnectAccountInput,
): Promise<SyncConnectAccountResult | null> {
  try {
    return await syncConnectAccount(deps, input);
  } catch (err) {
    deps.logger?.error("stripe_connect_account_sync_failed", {
      stripeAccountId: input.account.stripeAccountId,
      source: input.source,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      deps.reportError?.(err, {
        tags: {
          area: "stripe-connect",
          op: "sync-connect-account",
          source: input.source,
        },
        extra: { stripeAccountId: input.account.stripeAccountId },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return null;
  }
}
