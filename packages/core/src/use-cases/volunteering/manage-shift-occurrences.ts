import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerShiftOccurrenceRecord,
  VolunteerShiftOccurrenceWithClaimCountRecord,
} from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { formatEventStart } from "../comms/copy/common";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import {
  createShiftOccurrenceInputSchema,
  updateShiftOccurrenceInputSchema,
  cancelShiftOccurrenceInputSchema,
  listAskOccurrencesInputSchema,
  VOLUNTEER_OCCURRENCE_MAX_WINDOW_MS,
} from "./schemas";

/** The `volunteer.occurrence-cancelled` renderer's cap on the stored zone. */
const TIMEZONE_MAX_LENGTH = 100;

// ── Deps ────────────────────────────────────────────────────────────────────

export type ManageShiftOccurrencesDeps = {
  repos: Repos;
  clock: ClockPort;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  /**
   * Base URL for the cancellation deep link. Nullable — when unset (a
   * mis-wired composition root), the cancel itself still lands and the
   * account-linked notify() fan-out is SKIPPED with a reported config
   * warning (the strict renderer schema would reject a non-URL `askUrl`,
   * silently swallowing every send otherwise). Mirrors the
   * notify-booking-request-received posture.
   */
  appBaseUrl: string | null;
  /**
   * Direct cancellation email for SHADOW (no-account) claimants — they have
   * no notify() identity, so `notify()` can't reach them (FR-002). Optional:
   * absent = shadow sends are skipped, logged + reported (mirrors the
   * assignment-email posture).
   */
  mailer?: Pick<MailerPort, "send"> | null;
  logger?: LoggerPort;
  /**
   * Best-effort swallow reporter (Sentry) for caught-and-continued failures
   * (CLAUDE.md error-reporting convention). A throwing reporter must never
   * change behaviour.
   */
  reportError?: ReporterPort;
};

/** Trim trailing slashes; empty/unset collapses to null (no valid links). */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ── Shared resolution ───────────────────────────────────────────────────────

/**
 * Load an ask and gate it for occurrence management (FR-001/FR-002):
 * STANDING (non-EVENT) asks only — EVENT-subject asks keep their existing
 * EventVolunteerShift scheduling, so an EVENT ask uniformly 404s here (no
 * oracle distinguishing "exists but is event-flavored" from "missing";
 * mirrors how ask-owned role reads 404 event roles).
 */
async function resolveStandingAsk(
  tx: TxRepos,
  askId: string,
): Promise<VolunteerAskRecord> {
  const ask = await tx.volunteering.getAsk(askId);
  if (!ask || ask.subjectType === "EVENT") {
    throw fail("NOT_FOUND", {
      message: "ask_not_found",
      meta: { entity: "volunteer_ask" },
    });
  }
  return ask;
}

/**
 * Resolve an occurrence + its standing ask, with ownership gated via
 * `resolveAskOwnership` (THE ask trust gate) inside the ambient tx.
 */
async function resolveOwnedOccurrence(
  tx: TxRepos,
  occurrenceId: string,
  actorHumanId: string,
): Promise<{
  occurrence: VolunteerShiftOccurrenceRecord;
  ask: VolunteerAskRecord;
  /** The PLACE subject's IANA zone; null for ORG/HUMAN asks or an unset zone. */
  timezone: string | null;
}> {
  const occurrence = await tx.volunteering.getOccurrence(occurrenceId);
  if (!occurrence) {
    throw fail("OCCURRENCE_NOT_FOUND");
  }
  const ask = await resolveStandingAsk(tx, occurrence.askId);
  const ownership = await resolveAskOwnership(tx, ask, actorHumanId);
  return {
    occurrence,
    ask,
    timezone: ownership.place?.timezone || null,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Owner creates a one-off dated occurrence on an ask role (FR-002).
 *
 * - Standing (non-EVENT) asks only; the role must be ask-owned on the SAME
 *   ask (event roles and foreign-ask roles uniformly 404).
 * - `endsAt > startsAt` at the schema level.
 * - Authz: `resolveAskOwnership` inside the mutation tx.
 */
export async function createShiftOccurrence(
  deps: ManageShiftOccurrencesDeps,
  rawInput: unknown,
): Promise<VolunteerShiftOccurrenceRecord> {
  const input = parseInput(createShiftOccurrenceInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await resolveStandingAsk(tx, input.askId);
    await resolveAskOwnership(tx, ask, input.actorHumanId);

    const role = await tx.volunteering.getEventRole(input.roleId);
    if (!role || role.askId !== ask.id || role.eventId) {
      throw fail("ROLE_NOT_FOUND");
    }

    const created = await tx.volunteering.createOccurrence({
      askId: ask.id,
      roleId: role.id,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      capacity: input.capacity ?? null,
      notes: input.notes ?? null,
    });

    await tx.audit.log({
      entity: "volunteer_occurrence",
      entityId: created.id,
      action: "created",
      data: {
        askId: ask.id,
        roleId: role.id,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return created;
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Owner edits an occurrence's time / capacity / notes (FR-002). CANCELLED
 * occurrences are frozen (CONFLICT `occurrence_cancelled`) — the manual
 * path is create a replacement. When only one time bound arrives, the
 * MERGED window is validated against the stored row.
 */
export async function updateShiftOccurrence(
  deps: ManageShiftOccurrencesDeps,
  rawInput: unknown,
): Promise<VolunteerShiftOccurrenceRecord> {
  const input = parseInput(updateShiftOccurrenceInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { occurrence } = await resolveOwnedOccurrence(
      tx,
      input.occurrenceId,
      input.actorHumanId,
    );

    if (occurrence.status === "CANCELLED") {
      throw fail("CONFLICT", {
        message: "occurrence_cancelled",
        meta: { reason: "occurrence_cancelled" },
      });
    }

    const mergedStart = input.startsAt ?? occurrence.startsAt;
    const mergedEnd = input.endsAt ?? occurrence.endsAt;
    if (mergedEnd <= mergedStart) {
      throw fail("INVALID_INPUT", {
        message: "ends_before_starts",
      });
    }
    // Same 24h window cap as create — enforced on the MERGED window since a
    // patch can move one bound alone. Keeps duration-derived claim hours far
    // inside the Decimal(5,2) bound (999.99).
    if (
      mergedEnd.getTime() - mergedStart.getTime() >
      VOLUNTEER_OCCURRENCE_MAX_WINDOW_MS
    ) {
      throw fail("INVALID_INPUT", {
        message: "window_too_long",
      });
    }

    const updated = await tx.volunteering.updateOccurrence(input.occurrenceId, {
      ...(input.startsAt !== undefined && { startsAt: input.startsAt }),
      ...(input.endsAt !== undefined && { endsAt: input.endsAt }),
      ...(input.capacity !== undefined && { capacity: input.capacity }),
      ...(input.notes !== undefined && { notes: input.notes }),
    });

    await tx.audit.log({
      entity: "volunteer_occurrence",
      entityId: updated.id,
      action: "updated",
      data: {
        askId: updated.askId,
        roleId: updated.roleId,
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return updated;
  });
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/**
 * Everything the post-commit cancellation fan-out needs, collected inside
 * the cancel tx so the send loops never re-open repos. Account-linked
 * active claimants go through `notify()` (email + in-app, preference
 * aware); SHADOW claimants (no `humanId`) have no notify() identity, so
 * they get a direct best-effort mailer send instead.
 */
type OccurrenceCancelledFanout = {
  notifyRecipients: { claimId: string; humanId: string }[];
  shadowRecipients: {
    claimId: string;
    contactEmail: string;
    contactName: string | null;
  }[];
  scope: { kind: "ORG"; orgId: string } | { kind: "GLOBAL" };
  askId: string;
  askTitle: string;
  roleName: string;
  startsAt: Date;
  endsAt: Date;
  /** The ask's place zone (see resolveOwnedOccurrence); null = none known. */
  timezone: string | null;
};

/**
 * Owner cancels an occurrence (FR-002). Claims are NOT flipped (history
 * stays auditable); every active claimant is told exactly once per channel:
 *
 * - account-linked → `notify()` keyed `<occurrenceId>:cancelled:<claimId>`
 *   (per-channel derivation is notify()'s own),
 * - shadow (no account) → direct mailer send keyed
 *   `volunteer-occ-cancel:<claimId>`.
 *
 * Idempotent AND self-healing: a replay on an already-CANCELLED occurrence
 * skips the flip + audit but STILL rebuilds the active-claimant list and
 * re-runs both send loops — the stable idempotency keys dedupe real
 * duplicates, so a crash mid-fan-out is repaired by simply calling cancel
 * again (an early return here would permanently lose the remaining sends).
 */
export async function cancelShiftOccurrence(
  deps: ManageShiftOccurrencesDeps,
  rawInput: unknown,
): Promise<VolunteerShiftOccurrenceRecord> {
  const input = parseInput(cancelShiftOccurrenceInputSchema, rawInput);

  const { updated, fanout } = await deps.repos.tx(async (tx) => {
    const { occurrence, ask, timezone } = await resolveOwnedOccurrence(
      tx,
      input.occurrenceId,
      input.actorHumanId,
    );

    const alreadyCancelled = occurrence.status === "CANCELLED";

    // Replay: no re-flip, no duplicate audit row — but the fan-out below is
    // still rebuilt (healing property, see docblock).
    const updated = alreadyCancelled
      ? occurrence
      : await tx.volunteering.updateOccurrence(occurrence.id, {
          status: "CANCELLED",
        });

    // Collect active claimants in-tx; sends happen post-commit.
    const claims = await tx.volunteering.listClaimsByOccurrence(occurrence.id);
    const active = claims.filter((c) => c.status === "CLAIMED");
    const notifyRecipients = active
      .filter((c) => c.humanId !== null)
      .map((c) => ({ claimId: c.id, humanId: c.humanId! }));
    const shadowRecipients = active
      .filter((c) => c.humanId === null)
      .map((c) => ({
        claimId: c.id,
        contactEmail: c.contactEmail,
        contactName: c.contactName,
      }));

    const role = await tx.volunteering.getEventRole(occurrence.roleId);

    if (!alreadyCancelled) {
      await tx.audit.log({
        entity: "volunteer_occurrence",
        entityId: occurrence.id,
        action: "cancelled",
        data: {
          askId: ask.id,
          roleId: occurrence.roleId,
          actorHumanId: input.actorHumanId,
          claimantCount: active.length,
        },
        at: deps.clock.now(),
      });
    }

    const fanout: OccurrenceCancelledFanout | null =
      active.length > 0
        ? {
            notifyRecipients,
            shadowRecipients,
            scope: ask.orgId
              ? { kind: "ORG", orgId: ask.orgId }
              : { kind: "GLOBAL" },
            askId: ask.id,
            askTitle: ask.title,
            roleName: role?.name ?? "Volunteer",
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt,
            timezone,
          }
        : null;

    return { updated, fanout };
  });

  // Post-commit fan-out — failures logged + reported, never rolled back
  // (house convention; the stable idempotency keys make retries
  // exactly-once per channel).
  if (fanout) {
    const baseUrl = normalizeBaseUrl(deps.appBaseUrl);

    // Account-linked leg via notify(). A missing base URL would make the
    // strict renderer schema reject `askUrl` on EVERY send (silent total
    // loss) — skip the leg once, loudly, instead.
    if (fanout.notifyRecipients.length > 0 && !baseUrl) {
      deps.logger?.error(
        "volunteering.cancelShiftOccurrence.notify_skipped_no_base_url",
        { occurrenceId: updated.id, recipients: fanout.notifyRecipients.length },
      );
      try {
        deps.reportError?.(
          new Error("cancelShiftOccurrence: appBaseUrl unset — claimant notify() fan-out skipped"),
          {
            tags: { useCase: "cancelShiftOccurrence", stage: "notify" },
            extra: { occurrenceId: updated.id },
          },
        );
      } catch {
        // Best-effort reporting only.
      }
    } else if (baseUrl) {
      const payload = {
        askId: fanout.askId,
        askTitle: fanout.askTitle,
        occurrenceId: updated.id,
        roleName: fanout.roleName,
        startsAtIso: fanout.startsAt.toISOString(),
        endsAtIso: fanout.endsAt.toISOString(),
        askUrl: `${baseUrl}/v/${fanout.askId}`,
        // Omitted when unknown, or longer than the renderer's max(100) (the
        // strict schema would fail the whole send): the renderer then reads
        // the start in the platform default zone.
        ...(fanout.timezone && fanout.timezone.length <= TIMEZONE_MAX_LENGTH
          ? { timezone: fanout.timezone }
          : {}),
      };
      for (const recipient of fanout.notifyRecipients) {
        try {
          await deps.notify({
            humanId: recipient.humanId,
            variant: "volunteer.occurrence-cancelled",
            payload,
            scope: fanout.scope,
            idempotencyKey: `${updated.id}:cancelled:${recipient.claimId}`,
          });
        } catch (error) {
          deps.logger?.error(
            "volunteering.cancelShiftOccurrence.notify_failed",
            {
              occurrenceId: updated.id,
              claimId: recipient.claimId,
              recipientHumanId: recipient.humanId,
              error: describeError(error),
            },
          );
          try {
            deps.reportError?.(error, {
              tags: { useCase: "cancelShiftOccurrence", stage: "notify" },
              extra: { occurrenceId: updated.id, claimId: recipient.claimId },
            });
          } catch {
            // Reporting is best-effort — a throwing reporter must never
            // fail the already-persisted cancellation.
          }
        }
      }
    }

    // Shadow leg — direct mailer, no URL required (the link line is simply
    // omitted when the base URL is unset).
    for (const recipient of fanout.shadowRecipients) {
      try {
        if (!deps.mailer) {
          throw new Error("mailer_not_configured");
        }
        const greetingName = recipient.contactName?.trim() || "there";
        // Same rule as the in-app renderer: the place's local time, or the
        // platform default zone when the ask has none (formatEventStart's
        // fallback). The UTC string is only for an instant it cannot format.
        const when =
          formatEventStart("en", fanout.startsAt.toISOString(), fanout.timezone) ??
          fanout.startsAt.toUTCString();
        const textLines = [
          `Hi ${greetingName},`,
          `The ${fanout.roleName} shift you were scheduled for (${fanout.askTitle}, ${when}) has been cancelled. No action needed — you're no longer expected that day.`,
          ...(baseUrl ? [`View the schedule: ${baseUrl}/v/${fanout.askId}`] : []),
        ];
        await deps.mailer.send({
          to: {
            to: recipient.contactEmail,
            name: recipient.contactName ?? undefined,
          },
          subject: `Your ${fanout.roleName} shift for ${fanout.askTitle} was cancelled`,
          text: textLines.join("\n\n"),
          // Stable per-claim key: a replayed cancel (healing re-run) never
          // double-sends a shadow email.
          idempotencyKey: `volunteer-occ-cancel:${recipient.claimId}`,
          tags: ["volunteer", "occurrence", "cancelled"],
        });
      } catch (error) {
        deps.logger?.error(
          "volunteering.cancelShiftOccurrence.shadow_email_failed",
          {
            occurrenceId: updated.id,
            claimId: recipient.claimId,
            error: describeError(error),
          },
        );
        try {
          deps.reportError?.(error, {
            tags: { useCase: "cancelShiftOccurrence", stage: "shadow_email" },
            extra: { occurrenceId: updated.id, claimId: recipient.claimId },
          });
        } catch {
          // Best-effort reporting only.
        }
      }
    }
  }

  return updated;
}

// ── List (owner) ────────────────────────────────────────────────────────────

/**
 * Owner schedule read: the ask's occurrences with active-claim counts
 * (FR-005 groundwork — the roster per occurrence is `listOccurrenceRoster`).
 * Authz: `resolveAskOwnership`.
 */
export async function listAskOccurrences(
  deps: Pick<ManageShiftOccurrencesDeps, "repos" | "clock" | "logger">,
  rawInput: unknown,
): Promise<VolunteerShiftOccurrenceWithClaimCountRecord[]> {
  const input = parseInput(listAskOccurrencesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await resolveStandingAsk(tx, input.askId);
    await resolveAskOwnership(tx, ask, input.actorHumanId);

    return tx.volunteering.listOccurrencesByAsk(ask.id, {
      roleId: input.roleId,
      status: input.status,
      from: input.from,
      to: input.to,
      limit: input.limit,
    });
  });
}
