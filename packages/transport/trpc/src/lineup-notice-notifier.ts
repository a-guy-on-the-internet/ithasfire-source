import {
  makeLineupNoticeHooks,
  type LineupNoticeHooks,
} from "@th/core/use-cases/event-humans/notify-lineup-notices";

import type { Ctx } from "./context";

/**
 * Builds the lineup-notice hooks (owner ruling "option A",
 * 2026-09-30) that `eventHumans.attach`, `events.publishEvent` and
 * `events.inviteLineupHumanToRegister` inject into their use cases. Deps
 * assembly only — the timing and exactly-once rules live in core
 * (`notify-lineup-notices.ts`).
 *
 *  - `notifyWithEmail` binds the mailer so the notice's email leg sends
 *    inline; plain `notify` (email skips) is the fallback for composition
 *    roots that have not bound it.
 *  - `mailer` sends the payout INVITE directly: the invitee is usually a
 *    shadow profile, and notify() never emails an unverified address.
 *  - `lineupSweepContinuation` hands a publish sweep that ran out of budget
 *    to the jobs service (`lineup-notices.continue-sweep`).
 */
export function makeLineupNoticeNotifier(
  ctx: Pick<
    Ctx,
    | "repos"
    | "idempotency"
    | "notify"
    | "notifyWithEmail"
    | "mailer"
    | "publicAppUrl"
    | "logger"
    | "reportError"
    | "clock"
    | "rateLimit"
    | "lineupSweepContinuation"
  >,
): LineupNoticeHooks {
  return makeLineupNoticeHooks({
    repos: ctx.repos,
    idempotency: ctx.idempotency,
    notify: ctx.notifyWithEmail ?? ctx.notify,
    mailer: ctx.mailer ?? null,
    publicAppUrl: ctx.publicAppUrl ?? null,
    clock: ctx.clock,
    rateLimit: ctx.rateLimit,
    logger: ctx.logger,
    reportError: ctx.reportError ?? undefined,
    sweepContinuation: ctx.lineupSweepContinuation ?? null,
  });
}
