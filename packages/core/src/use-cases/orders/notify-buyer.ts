import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { describeError } from "../../lib/io";

export type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

/**
 * Determines whether a buyer is a real, loginable account that should receive
 * in-app notifications.
 *
 * Two buyer shapes never get an in-app feed entry:
 *
 *  - **POS_WALKUP phantom buyers** (in-person card/cash sales): a bare Human
 *    row with no AuthUser at all — they can never sign in.
 *  - **Guest-checkout shadow buyers** (`ensureGuestHuman`): a Human linked to a
 *    shadow AuthUser created with no `AuthAccount` rows (no password
 *    `credential`, no OAuth). They keep their existing receipt email instead.
 *
 * A real account — password signup (`credential`) or OAuth (`google`/`apple`) —
 * always has at least one linked `AuthAccount`, so the presence of an auth
 * account is the first half of the signal. The second half is a VERIFIED
 * email (B2, account squatting, owner ruling 2026-10-16): a password signup
 * is loginable before verification, so anyone can hold an unverified account
 * under someone else's address, and guest checkout, comps and door sales
 * attach orders to it BY EMAIL. Such an account is treated as not loginable:
 * no in-app or push entry reaches whoever signed it up, and the ticket email
 * (which goes to the inbox) keeps its `/auth/complete` claim link. Proving
 * the inbox flips `emailVerified` and runs the unproven-account sweep.
 *
 * Note: Better Auth passkeys are stored as WebAuthn credentials, NOT as
 * `AuthAccount` rows, so a hypothetical passkey-only buyer would be skipped
 * here. That can't happen today — checkout requires an already-authenticated
 * account, and every such account was bootstrapped with a `credential`/OAuth
 * `AuthAccount` before a passkey could be enrolled.
 *
 * Fail-safe: any lookup error returns `false` (skip) — a notification must never
 * break the order flow. `false` is also the B2-safe side (no in-app entry, the
 * email keeps its claim link). The swallow is reported.
 */
export async function isLoginableBuyer(
  deps: { repos: Pick<Repos, "humans">; reportError?: ReporterPort | null },
  humanId: string,
): Promise<boolean> {
  try {
    const accounts = await deps.repos.humans.listAuthAccounts(humanId);
    if (accounts.length === 0) return false;
    const human = await deps.repos.humans.getByIdWithIdentity(humanId);
    return human?.identity.emailVerified === true;
  } catch (error) {
    try {
      deps.reportError?.(error, {
        tags: { useCase: "isLoginableBuyer", branch: "lookup_failed" },
        extra: { humanId },
      });
    } catch {
      // Best-effort reporting; never changes behaviour.
    }
    return false;
  }
}

/**
 * Fire-and-forget in-app (+ push) notification to a real, loginable buyer.
 *
 * - SKIPS guest / POS_WALKUP buyers (they keep their existing email receipt).
 * - NEVER throws — any failure is swallowed and logged. Callers MUST invoke
 *   this AFTER the order/refund/resale mutation has durably committed so a
 *   notify outage can't roll back or fail the money-moving flow.
 * - Email is left to the dedicated receipt/refund mailers; this only emits the
 *   in-app and push channels.
 */
export async function notifyBuyer(
  deps: {
    repos: Pick<Repos, "humans">;
    notify?: NotifyFn;
    logger?: LoggerPort;
    /** The loginability lookup and the notify call are both swallowed. */
    reportError?: ReporterPort | null;
  },
  input: {
    buyerHumanId: string;
    variant: NotifyInput["variant"];
    payload: NotifyInput["payload"];
    idempotencyKey: string;
  },
): Promise<void> {
  if (!deps.notify) return;

  try {
    const loginable = await isLoginableBuyer(deps, input.buyerHumanId);
    if (!loginable) {
      deps.logger?.info?.("orders.notify_buyer.skipped_non_loginable", {
        buyerHumanId: input.buyerHumanId,
        variant: input.variant,
      });
      return;
    }

    await deps.notify({
      humanId: input.buyerHumanId,
      variant: input.variant,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      channels: {
        inApp: { enabled: true },
        // Push is only delivered when the renderer emits a push payload and the
        // buyer's prefs allow it; email/sms stay off so we never double-send.
        email: { enabled: false },
        sms: { enabled: false },
      },
    });
  } catch (error) {
    deps.logger?.warn?.("orders.notify_buyer.failed", {
      buyerHumanId: input.buyerHumanId,
      variant: input.variant,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "notifyBuyer", branch: "notify_failed" },
        extra: { buyerHumanId: input.buyerHumanId, variant: input.variant },
      });
    } catch {
      // Best-effort reporting; never changes behaviour.
    }
  }
}
