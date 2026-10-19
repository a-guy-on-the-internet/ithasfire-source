import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError, parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { ensureGuestHumanKeepingName } from "../../lib/ensure-guest-human";
import type { LineupNoticeHooks } from "../event-humans/notify-lineup-notices";

export const inviteLineupHumanToRegisterInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventHumanId: z.string().uuid(),
    email: z.string().email().max(254),
    /**
     * Optional registered display name. Defaults to the row's existing
     * `externalName` (the stage name the organizer typed in).
     */
    displayName: plainTextRequired(140).optional(),
  })
  .strict();

/**
 * Deliberately JUST the row id. `humanId` / `createdHuman` used to be here,
 * which told any editor whether an arbitrary address already has an account
 * (and every probe now mails that address). No caller read them.
 */
export const inviteLineupHumanToRegisterOutputSchema = z
  .object({
    eventHumanId: z.string().uuid(),
  })
  .strict();

export type InviteLineupHumanToRegisterInput = z.infer<
  typeof inviteLineupHumanToRegisterInputSchema
>;
export type InviteLineupHumanToRegisterOutput = z.infer<
  typeof inviteLineupHumanToRegisterOutputSchema
>;

export type InviteLineupHumanToRegisterDeps = {
  repos: Pick<Repos, "tx" | "eventHumans" | "humans" | "audit">;
  authz: Pick<AuthZPort, "canEditEvent">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Lineup-notice hooks (owner ruling "option A", 2026-09-30) —
   * `makeLineupNoticeHooks` from event-humans/notify-lineup-notices.
   * `recordOwed` runs BEFORE the link's tx (the row id is already known);
   * `dispatch` post-commit sends the payout invite email now, and the
   * person's lineup notice by the lineup timing rules (now if PUBLISHED,
   * else at publish; in-app + push only, since the invite is their email).
   * Optional: without it nothing is sent, which is what this use case did
   * before.
   */
  lineupNotices?: LineupNoticeHooks;
  /** Reports a swallowed notice failure (the link still succeeds). */
  reportError?: ReporterPort;
};

/**
 * Upgrades a free-text lineup row to a registered Human via
 * `humans.ensureGuestHuman`, then stamps `humanId` on the EventHuman row.
 *
 * `ensureGuestHuman` creates a shadow AuthUser for an address with no
 * account, which is what the existing onboarding flows key off. After the
 * link commits, the injected `lineupNotices.dispatch` hook emails the payout
 * invite (Connect-onboarding link, plus a finish-your-account step for a
 * shadow profile) and schedules the person's lineup notice. This docstring
 * used to promise that "the transport layer sends a transactional email";
 * nothing ever did, while the builder toasted "Invite sent".
 *
 * Idempotent on `(eventHumanId, email)`: re-invoking with the same email
 * just re-resolves the same Human and is a no-op on the EventHuman row
 * if `humanId` is already stamped to the matching Human.
 */
export async function inviteLineupHumanToRegister(
  deps: InviteLineupHumanToRegisterDeps,
  rawInput: unknown,
): Promise<InviteLineupHumanToRegisterOutput> {
  const input = parseInput(inviteLineupHumanToRegisterInputSchema, rawInput);

  const row = await deps.repos.eventHumans.getById(input.eventHumanId);
  if (!row) {
    throw fail("EVENT_HUMAN_NOT_FOUND");
  }

  const canEdit = await deps.authz.canEditEvent({
    actorHumanId: input.actorHumanId,
    eventId: row.eventId,
  });
  if (!canEdit.allowed) {
    throw fail("INSUFFICIENT_ROLE");
  }

  // Already-registered rows are not eligible. The organizer can use the
  // existing detach + re-attach flow if they want to swap people.
  if (row.humanId && row.humanId.length > 0) {
    throw fail("LINEUP_ROW_ALREADY_REGISTERED");
  }

  const displayName = input.displayName?.trim() ?? row.externalName ?? "Guest";

  // Never renames an existing account: the organizer types both the email
  // and the display name.
  const ensured = await ensureGuestHumanKeepingName(deps.repos.humans, {
    email: input.email,
    name: displayName,
  });

  // Owed BEFORE the link commits (row id known here): a crash after the
  // commit can no longer lose it. A failed link leaves an inert record on a
  // row that stays unlinked. Never throws. Never for the actor's own account.
  if (deps.lineupNotices && ensured.humanId !== input.actorHumanId) {
    await deps.lineupNotices.recordOwed({
      eventHumanId: input.eventHumanId,
      addedByHumanId: input.actorHumanId,
      via: "invite",
    });
  }

  const updated = await deps.repos.tx(async (tx) => {
    return tx.eventHumans.linkHuman({
      id: input.eventHumanId,
      humanId: ensured.humanId,
    });
  });

  const now = deps.clock.now();
  await deps.repos.audit.log({
    entity: "event_human",
    entityId: input.eventHumanId,
    action: "lineup_human_upgraded_to_registered",
    data: {
      eventId: row.eventId,
      humanId: ensured.humanId,
      email: input.email,
      createdHuman: ensured.created,
      actorHumanId: input.actorHumanId,
    },
    at: now,
  });

  deps.logger?.info("events.invite_lineup_human_to_register", {
    eventHumanId: input.eventHumanId,
    eventId: row.eventId,
    humanId: ensured.humanId,
    createdHuman: ensured.created,
    actorHumanId: input.actorHumanId,
  });

  if (deps.lineupNotices && ensured.humanId !== input.actorHumanId) {
    const noticeArgs = {
      eventId: row.eventId,
      eventHumanId: input.eventHumanId,
      addedByHumanId: input.actorHumanId,
    };
    try {
      await deps.lineupNotices.dispatch({
        kind: "invited",
        ...noticeArgs,
        humanId: ensured.humanId,
        email: input.email,
      });
    } catch (error) {
      // Swallowed: the link is committed. Logged at error + reported
      // (ReporterPort convention) so a silent "Invite sent" is visible.
      deps.logger?.error("events.invite_lineup_human_to_register.notice_failed", {
        ...noticeArgs,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "inviteLineupHumanToRegister", stage: "lineup_notice" },
          extra: noticeArgs,
        });
      } catch {
        // A throwing reporter must never change the outcome.
      }
    }
  }

  return inviteLineupHumanToRegisterOutputSchema.parse({
    eventHumanId: updated.id,
  });
}
