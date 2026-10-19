import { randomUUID } from "node:crypto";

import { z } from "zod";
import { toSafeExternalUrl } from "@th/types";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError, parseInput } from "../../lib/io";
import { ensureOwnerOrCommunityModerator } from "../events/_shared/ensure-owner-or-community-moderator";
import { fail } from "@th/errors";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import type { LineupNoticeHooks } from "./notify-lineup-notices";
import { reportSafely } from "./_shared/lineup-notice-support";

const EVENT_HUMAN_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "VOLUNTEER",
  "OTHER",
] as const;

export const attachEventHumanInput = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  humanId: z.uuid().optional().nullable(),
  externalName: plainTextRequired(120).optional().nullable(),
  externalUrl: z
    .string()
    .url()
    .max(500)
    .optional()
    .nullable()
    .refine(
      (value) => {
        return value == null || toSafeExternalUrl(value) !== null;
      },
      {
        message: "external_url_invalid_protocol",
      },
    ),
  role: z.enum(EVENT_HUMAN_ROLES).default("PERFORMER"),
  customRoleLabel: plainTextOptional(60).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).optional().default(0),
});

export const attachEventHumanOutput = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  humanId: z.uuid().nullable(),
  externalName: z.string().nullable(),
  externalUrl: z.string().nullable(),
  role: z.enum(EVENT_HUMAN_ROLES),
  customRoleLabel: z.string().nullable(),
  sortOrder: z.number().int(),
});

export type AttachEventHumanUseCaseInput = z.infer<
  typeof attachEventHumanInput
>;
export type AttachEventHumanUseCaseOutput = z.infer<
  typeof attachEventHumanOutput
>;

export type AttachEventHumanDeps = {
  repos: Repos;
  /**
   * Admits a community moderator to an ownerless listing's lineup — see
   * {@link ensureOwnerOrCommunityModerator}. Required, not optional: an
   * omitted probe would fail closed and silently refuse every lineup write
   * on a community listing.
   */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * "You're on the lineup" hooks (owner ruling "option A", 2026-09-30) —
   * `makeLineupNoticeHooks` from ./notify-lineup-notices. Used only for a
   * NEW row linked to someone other than the actor: `recordOwed` BEFORE the
   * tx, keyed on the row id this use case pre-generates (so the owed fact
   * cannot be lost to a crash after commit, and no non-tx I/O runs inside
   * the interactive tx), then `dispatch` post-commit, which decides between
   * "tell them now" (PUBLISHED) and "tell them at publish". Optional: seeds
   * and scripts attach without telling anyone.
   */
  lineupNotices?: LineupNoticeHooks;
  /**
   * Per-actor budget on attaching SOMEONE ELSE (each such attach can mail
   * them): {@link ATTACH_PERSON_MAX} per {@link ATTACH_PERSON_WINDOW_SECONDS}.
   * Free-text rows and self-attach are never charged. Fails OPEN on a
   * limiter error (reported) — the same stance as the router-level limits.
   * Absent (seeds, scripts) = no budget.
   */
  rateLimit?: RateLimitPort | null;
  /** Reports a swallowed notice failure (the attach still succeeds). */
  reportError?: ReporterPort;
};

export async function attachEventHuman(
  deps: AttachEventHumanDeps,
  rawInput: unknown,
): Promise<AttachEventHumanUseCaseOutput> {
  const input = parseInput(attachEventHumanInput, rawInput);

  // Must provide at least humanId or externalName
  if (!input.humanId && !input.externalName) {
    throw fail("HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED");
  }

  // A linked person other than the actor: the only attach that can mail
  // anyone, so the only one charged and the only one owed a notice.
  const otherPersonId =
    input.humanId && input.humanId !== input.actorHumanId
      ? input.humanId
      : null;
  // Pre-generated so OWED can be written BEFORE the tx; the upsert creates
  // the row with it, and a returned row with a DIFFERENT id is a re-attach.
  const newRowId = randomUUID();
  let owedWritten = false;
  if (otherPersonId) {
    // AUTHORIZE FIRST. The probe, the budget charge and the 10-year OWED
    // write below must never run for a caller who cannot edit this lineup:
    // otherwise "already on it" (no charge → refused) vs "not on it"
    // (RATE_LIMITED once the budget is spent) is a cross-tenant lineup-
    // membership oracle, and a stranger could plant OWED records. Same
    // checks as the tx (which repeats them against its own snapshot).
    const preEvent = await ensureEventExists(deps.repos, input.eventId);
    await ensureOwnerOrCommunityModerator(
      { repos: deps.repos, authz: deps.authz },
      preEvent,
      input.actorHumanId,
    );

    const already = await deps.repos.eventHumans.getByEventAndHuman({
      eventId: input.eventId,
      humanId: otherPersonId,
    });
    if (!already) {
      await chargeAttachBudget(deps, input.actorHumanId);
      if (deps.lineupNotices) {
        // Never throws. A rolled-back attach leaves an inert OWED for a row
        // id that never existed.
        await deps.lineupNotices.recordOwed({
          eventHumanId: newRowId,
          addedByHumanId: input.actorHumanId,
          via: "attach",
        });
        owedWritten = true;
      }
    }
  }

  const result = await deps.repos.tx(async (tx) => {
    const event = await ensureEventExists(tx, input.eventId);
    await ensureOwnerOrCommunityModerator(
      { repos: tx, authz: deps.authz },
      event,
      input.actorHumanId,
    );

    const record = await tx.eventHumans.attach({
      ...(otherPersonId ? { id: newRowId } : {}),
      eventId: input.eventId,
      humanId: input.humanId ?? null,
      externalName: input.externalName ?? null,
      externalUrl: input.externalUrl ?? null,
      role: input.role,
      customRoleLabel:
        input.role === "OTHER" ? (input.customRoleLabel ?? null) : null,
      sortOrder: input.sortOrder,
    });

    const now = deps.clock.now();
    await tx.audit.log({
      entity: "event_human",
      entityId: record.id,
      action: "attached",
      data: {
        eventId: input.eventId,
        humanId: input.humanId ?? null,
        externalName: input.externalName ?? null,
        role: input.role,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    return record;
  });

  // Created (our id came back) — not a concurrent attach that won the row.
  if (owedWritten && result.id === newRowId) {
    await fireLineupAddedNotice(deps, {
      eventId: input.eventId,
      eventHumanId: newRowId,
      addedByHumanId: input.actorHumanId,
    });
  }

  return attachEventHumanOutput.parse({
    id: result.id,
    eventId: result.eventId,
    humanId: result.humanId,
    externalName: result.externalName,
    externalUrl: result.externalUrl,
    role: result.role,
    customRoleLabel: result.customRoleLabel,
    sortOrder: result.sortOrder,
  });
}

async function ensureEventExists(
  tx: Pick<TxRepos, "events">,
  eventId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  return event;
}

/**
 * Post-commit, and swallowed: the attach is committed, so a notice failure is
 * logged + reported (CLAUDE.md ReporterPort convention), never thrown.
 */
async function fireLineupAddedNotice(
  deps: AttachEventHumanDeps,
  args: { eventId: string; eventHumanId: string; addedByHumanId: string },
): Promise<void> {
  try {
    await deps.lineupNotices?.dispatch({ kind: "attached", ...args });
  } catch (error) {
    deps.logger?.error("event_humans.attach.lineup_notice_failed", {
      ...args,
      error: describeError(error),
    });
    reportSafely(deps.reportError, error, {
      tags: { useCase: "attachEventHuman", stage: "lineup_notice" },
      extra: args,
    });
  }
}

export const ATTACH_PERSON_MAX = 120;
export const ATTACH_PERSON_WINDOW_SECONDS = 3600;

/**
 * 120 people an hour clears a big festival bill built in one sitting; a spam
 * run tops out at 120 addresses an hour per account. Fails OPEN (reported).
 */
async function chargeAttachBudget(
  deps: AttachEventHumanDeps,
  actorHumanId: string,
): Promise<void> {
  if (!deps.rateLimit) return;
  let result;
  try {
    result = await deps.rateLimit.consume(
      `eventHumans:attach:actor:${actorHumanId}`,
      ATTACH_PERSON_MAX,
      ATTACH_PERSON_WINDOW_SECONDS,
    );
  } catch (error) {
    deps.logger?.error("event_humans.attach.rate_limit_failed_open", {
      actorHumanId,
      error: describeError(error),
    });
    reportSafely(deps.reportError, error, {
      tags: { useCase: "attachEventHuman", stage: "rate_limit" },
      extra: { actorHumanId },
    });
    return;
  }
  if (!result.allowed) {
    throw fail("RATE_LIMITED", {
      meta: {
        scope: "event_humans_attach_person",
        retryAfterSeconds: result.retryAfterSeconds,
      },
    });
  }
}
