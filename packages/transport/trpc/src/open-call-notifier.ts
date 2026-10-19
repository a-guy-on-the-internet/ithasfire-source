import {
  makeOpenCallNotices,
  type OpenCallNotices,
} from "@th/core/use-cases/events/open-calls/notify-open-call-notices";

import type { Ctx } from "./context";

/**
 * Builds the open-call notifiers (spec 2026-10-05, step 7) that the open-call
 * use cases take as optional seams: `notifyOpenCallApplicationReceived`
 * (submit), `notifyOpenCallPicked`, `notifyOpenCallNotThisTime` (decline AND
 * close), `notifyOpenCallDroppedOut` (drop out AND `eventHumans.leave`),
 * `notifyApplicationMessagePosted`, and `notifyOpenCallPulled` (step 8's job
 * builds its own from the jobs container). Deps assembly only: recipients,
 * copy and exactly-once live in core (`notify-open-call-notices.ts`).
 *
 *  - `notifyWithEmail` binds the mailer so a signed-in recipient's email leg
 *    sends; plain `notify` (email skips) is the fallback for composition
 *    roots that have not bound it, as for the lineup notices.
 *  - `mailer` sends a guest's email directly (a guest has no account).
 *  - `openCallStatusTokenSecret` (HKDF of UNSUBSCRIBE_SECRET) lets
 *    core re-derive a guest's status link at send time (owner ruling
 *    2026-10-07). Unset → guest emails fail, are reported, and wait for a
 *    reconcile; signed-in notices never carry a token either way.
 */
export function makeOpenCallNotifier(
  ctx: Pick<
    Ctx,
    | "repos"
    | "idempotency"
    | "notify"
    | "notifyWithEmail"
    | "mailer"
    | "publicAppUrl"
    | "openCallStatusTokenSecret"
    | "logger"
    | "reportError"
  >,
): OpenCallNotices {
  return makeOpenCallNotices({
    repos: ctx.repos,
    idempotency: ctx.idempotency,
    notify: ctx.notifyWithEmail ?? ctx.notify,
    mailer: ctx.mailer ?? null,
    publicAppUrl: ctx.publicAppUrl ?? null,
    statusTokenSecret: ctx.openCallStatusTokenSecret ?? null,
    logger: ctx.logger,
    reportError: ctx.reportError ?? undefined,
  });
}
