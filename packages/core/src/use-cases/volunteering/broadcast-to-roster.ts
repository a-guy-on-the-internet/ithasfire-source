import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type {
  VolunteerBroadcastRecord,
  VolunteerBroadcastRecipient,
} from "@th/ports/repos/volunteering";
import { fail, isAppError } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import { getNotificationCategoryConfig } from "../comms/categories";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { VOLUNTEER_BROADCAST_CATEGORY } from "../comms/renderers";
import { isChannelEnabled } from "../comms/shared";
import {
  ensureCoordinatorEmailVerified,
  OWNERSHIP_DENIAL_CODES,
} from "./_shared/require-coordinator-or-owner";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { broadcastToRosterInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type BroadcastToRosterDeps = {
  repos: Repos;
  clock: ClockPort;
  /** Direct sends — shadow (humanId-less) volunteers have no notify path. */
  mailer: Pick<MailerPort, "send">;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  appBaseUrl: string;
  logger?: LoggerPort;
};

export type BroadcastToRosterOutput = {
  ok: true;
  broadcastId: string;
  recipientCount: number;
};

/**
 * One deduped deliverable: the earliest signup per contact email (the
 * recipients read is createdAt-ascending, so "first wins" is stable
 * across retries and the per-recipient mailer idempotency key —
 * (broadcastId, representative signupId) — is deterministic).
 */
type Deliverable = VolunteerBroadcastRecipient;

/**
 * One-way roster announcement (FR-009, `broadcast_messaging` decision).
 *
 * Authorization (mirrors the spec's broadcast scope table):
 * - Ask OWNER (`resolveAskOwnership`): any scope (ALL | ROLE | GROUP | POOL).
 * - COORDINATOR: ONLY `GROUP` scope naming a group they coordinate on this
 *   ask, verified fresh in the same tx (NFR-002). Every other scope — and a
 *   GROUP scope naming someone else's or a foreign-ask group — rethrows the
 *   ORIGINAL ownership denial, so a cross-group coordinator is
 *   indistinguishable from a stranger (uniform `forbidden`, never a 404 —
 *   same anti-oracle rule as require-coordinator-or-owner).
 * - Owner-path scoped targets must belong to the ask; a foreign-ask
 *   role/group 404s uniformly (assign-signup-to-group's convention — never
 *   confirm a foreign target exists).
 *
 * Status: only ARCHIVED asks refuse broadcasts. CLOSED/PAUSED rosters are
 * legitimately messageable — FR-007's "closing/pausing stops new signups
 * but preserves the roster" means "the show is cancelled" announcements
 * must still go out; ARCHIVED is the retired-entirely state.
 *
 * Idempotency (spec: "keyed on broadcastId to prevent double-send on
 * retry"): the optional client-supplied `broadcastId` becomes the ledger
 * row's pk. In-tx, AFTER authz, a `getBroadcast` PRE-READ detects a replay
 * and returns the stored `{ broadcastId, recipientCount }` without
 * re-resolving recipients or re-sending — a pre-read rather than a
 * create-and-catch because an in-tx P2002 aborts the Postgres tx (25P02)
 * and would poison every later statement. A retry racing the original
 * (pre-read misses, create collides) surfaces the adapter's
 * `duplicate_broadcast` as a retryable CONFLICT: the tx is already aborted,
 * the client retries and hits the replay pre-read. A replayed id whose
 * stored row doesn't match this request's ask/scope/content is a key-reuse
 * bug → IDEMPOTENCY_KEY_CONFLICT (notify's payload-consistency rule).
 *
 * Delivery, post-commit (house convention — failures logged, never fail
 * the use case):
 * - EMAIL to every recipient's roster `contactEmail` via MailerPort,
 *   deduped by lowercased email (the recipients read is one row per
 *   signup), idempotency-keyed per (broadcastId, representative signupId).
 *   Reply-To is the owning org's contactEmail when the ask is org-owned
 *   and one is on file (spec: "reply-to the sender's org/ask contact" —
 *   the same source invite-member uses); otherwise omitted. For
 *   recipients WITH a humanId, this leg respects NotificationPreference
 *   (FR-009 "delivery respects NotificationPreference") via the SAME
 *   effective read notify uses — `readEffective` with the identical
 *   scope resolution (ORG when org-owned, else GLOBAL) and the
 *   `volunteer.broadcast` renderer's category
 *   (VOLUNTEER_BROADCAST_CATEGORY = organizerMessages) — so the email
 *   and in-app legs gate on one preference. A disabled email channel
 *   skips the send (logged). A preference-READ failure also skips
 *   (fail-closed) — the codebase's uniform posture: notify itself fails
 *   the send when `readEffective` throws, and send-announcement's
 *   consent filter aborts dispatch ("a consent/legal violation, not a
 *   best-effort concern"). Shadow (humanId-less) recipients have no
 *   preferences and are always emailed — it's their only channel.
 * - IN-APP via the standard notify pipeline (`volunteer.broadcast`
 *   renderer, in-app only so account holders aren't double-emailed) for
 *   recipients with a humanId, NotificationPreference respected, ORG scope
 *   when the ask is org-owned else GLOBAL. Shadow recipients get email
 *   only.
 *
 * `recipientCount` on the ledger row is the DEDUPED contact count — the
 * number of people actually addressed, not raw signup rows.
 */
export async function broadcastToRoster(
  deps: BroadcastToRosterDeps,
  rawInput: unknown,
): Promise<BroadcastToRosterOutput> {
  const input = parseInput(broadcastToRosterInputSchema, rawInput);
  const scopeId =
    input.scope.kind === "ROLE"
      ? input.scope.roleId
      : input.scope.kind === "GROUP"
        ? input.scope.groupId
        : null;

  const result = await deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    // ── Authorize ─────────────────────────────────────────────────────
    let via: "owner" | "coordinator";
    try {
      await resolveAskOwnership(tx, ask, input.actorHumanId);
      via = "owner";
    } catch (error) {
      if (!(isAppError(error) && OWNERSHIP_DENIAL_CODES.has(error.code))) {
        throw error;
      }
      // Coordinator leg: GROUP scope on their own group ONLY. Anything
      // else (incl. foreign/cross-group probes) rethrows the original
      // denial — uniformly `forbidden`.
      if (input.scope.kind !== "GROUP") {
        throw error;
      }
      const group = await tx.volunteering.getGroup(input.scope.groupId);
      if (
        !group ||
        group.askId !== ask.id ||
        group.coordinatorHumanId === null ||
        group.coordinatorHumanId !== input.actorHumanId
      ) {
        throw error;
      }
      await ensureCoordinatorEmailVerified(tx, input.actorHumanId);
      via = "coordinator";
    }

    // Owner-path scoped targets must belong to this ask (foreign targets
    // 404 uniformly — assign-signup-to-group's convention).
    if (via === "owner" && input.scope.kind === "ROLE") {
      const role = await tx.volunteering.getEventRole(input.scope.roleId);
      if (!role || role.askId !== ask.id) {
        throw fail("NOT_FOUND", {
          message: "role_not_found",
          meta: { entity: "volunteer_role" },
        });
      }
    }
    if (via === "owner" && input.scope.kind === "GROUP") {
      const group = await tx.volunteering.getGroup(input.scope.groupId);
      if (!group || group.askId !== ask.id) {
        throw fail("NOT_FOUND", {
          message: "group_not_found",
          meta: { entity: "volunteer_group" },
        });
      }
    }

    // ── Idempotent replay (pre-read AFTER authz — never an unauthorized
    // probe). See the function doc for why this is a pre-read.
    if (input.broadcastId) {
      const existing = await tx.volunteering.getBroadcast(input.broadcastId);
      if (existing) {
        if (
          existing.askId !== ask.id ||
          existing.senderHumanId !== input.actorHumanId ||
          existing.scopeType !== input.scope.kind ||
          existing.scopeId !== scopeId ||
          existing.subject !== input.subject ||
          existing.body !== input.body
        ) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return { replay: true as const, broadcast: existing };
      }
    }

    // ARCHIVED = retired; checked after authz + replay so a retry of a
    // pre-archive send still replays cleanly and status never doubles as
    // an existence probe.
    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    // ── Resolve + dedupe recipients ───────────────────────────────────
    const rows = await tx.volunteering.listBroadcastRecipients(
      ask.id,
      input.scope,
    );
    const byEmail = new Map<string, Deliverable>();
    for (const row of rows) {
      const key = row.contactEmail.toLowerCase();
      const existing = byEmail.get(key);
      if (!existing) {
        byEmail.set(key, row);
      } else if (!existing.humanId && row.humanId) {
        // Keep the earliest signup as the mailer-idempotency
        // representative, but never lose the account linkage a later
        // signup carries.
        byEmail.set(key, { ...existing, humanId: row.humanId });
      }
    }
    const deliverables = [...byEmail.values()];

    let broadcast: VolunteerBroadcastRecord;
    try {
      broadcast = await tx.volunteering.createBroadcast({
        id: input.broadcastId ?? null,
        askId: ask.id,
        senderHumanId: input.actorHumanId,
        scopeType: input.scope.kind,
        scopeId,
        subject: input.subject,
        body: input.body,
        recipientCount: deliverables.length,
      });
    } catch (error) {
      // Retry racing the original send: the P2002 already aborted this
      // tx — surface a retryable conflict; the client's retry hits the
      // replay pre-read above. The adapter throws a PLAIN `{ code }`
      // object (duplicate_event_ask convention), not an AppError.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "duplicate_broadcast"
      ) {
        throw fail("CONFLICT", {
          message: "duplicate_broadcast",
          meta: { reason: "duplicate_broadcast", retryable: true },
        });
      }
      throw error;
    }

    await tx.audit.log({
      entity: "volunteer_broadcast",
      entityId: broadcast.id,
      action: "broadcast_sent",
      data: {
        askId: ask.id,
        scopeType: input.scope.kind,
        scopeId,
        recipientCount: deliverables.length,
        actorHumanId: input.actorHumanId,
        via,
      },
      at: deps.clock.now(),
    });

    // Reply-To source, read in the same tx (invite-member's convention).
    let replyTo: { to: string; name?: string } | null = null;
    if (ask.orgId) {
      const org = await tx.organizations.getById(ask.orgId);
      if (org?.contactEmail) {
        replyTo = { to: org.contactEmail, name: org.name };
      }
    }

    return {
      replay: false as const,
      broadcast,
      ask,
      deliverables,
      replyTo,
    };
  });

  if (result.replay) {
    return {
      ok: true,
      broadcastId: result.broadcast.id,
      recipientCount: result.broadcast.recipientCount,
    };
  }

  const { broadcast, ask, deliverables, replyTo } = result;
  const scope = ask.orgId
    ? ({ kind: "ORG", orgId: ask.orgId } as const)
    : ({ kind: "GLOBAL" } as const);

  // ── Post-commit delivery — per-recipient, failures logged only ──────────
  for (const recipient of deliverables) {
    // FR-009: account holders' email-channel preference gates the direct
    // send (see the function doc — same read/scope/category as the in-app
    // leg; read failure = skip, fail-closed). Shadow recipients have no
    // preferences: always email.
    let emailEnabled = true;
    if (recipient.humanId) {
      try {
        const preferences = await deps.repos.notificationPrefs.readEffective({
          humanId: recipient.humanId,
          scope,
        });
        emailEnabled = isChannelEnabled(
          preferences,
          "email",
          VOLUNTEER_BROADCAST_CATEGORY,
          getNotificationCategoryConfig(VOLUNTEER_BROADCAST_CATEGORY)
            .emailDefaultEnabled,
        );
        if (!emailEnabled) {
          deps.logger?.info("volunteering.broadcastToRoster.email_skipped", {
            broadcastId: broadcast.id,
            signupId: recipient.signupId,
            askId: ask.id,
            reason: "channel_disabled",
          });
        }
      } catch (error) {
        emailEnabled = false;
        deps.logger?.error(
          "volunteering.broadcastToRoster.preference_read_failed",
          {
            broadcastId: broadcast.id,
            signupId: recipient.signupId,
            askId: ask.id,
            error: describeError(error),
          },
        );
      }
    }

    if (emailEnabled) {
      try {
        await deps.mailer.send({
          to: {
            to: recipient.contactEmail,
            ...(recipient.contactName ? { name: recipient.contactName } : {}),
          },
          ...(replyTo ? { replyTo } : {}),
          subject: input.subject,
          text: `${input.body}\n\n—\nYou're receiving this because you volunteer for ${ask.title}.`,
          idempotencyKey: `volunteer-broadcast:${broadcast.id}:${recipient.signupId}`,
          tags: ["volunteer", "broadcast"],
          metadata: { askId: ask.id, broadcastId: broadcast.id },
        });
      } catch (error) {
        deps.logger?.error("volunteering.broadcastToRoster.email_failed", {
          broadcastId: broadcast.id,
          signupId: recipient.signupId,
          askId: ask.id,
          error: describeError(error),
        });
      }
    }

    if (recipient.humanId) {
      try {
        await deps.notify({
          humanId: recipient.humanId,
          variant: "volunteer.broadcast",
          payload: {
            askId: ask.id,
            broadcastId: broadcast.id,
            askTitle: ask.title,
            subject: input.subject,
            body: input.body,
          },
          scope,
          idempotencyKey: `${broadcast.id}:broadcast:${recipient.humanId}`,
        });
      } catch (error) {
        deps.logger?.error("volunteering.broadcastToRoster.notify_failed", {
          broadcastId: broadcast.id,
          recipientHumanId: recipient.humanId,
          askId: ask.id,
          error: describeError(error),
        });
      }
    }
  }

  return {
    ok: true,
    broadcastId: broadcast.id,
    recipientCount: broadcast.recipientCount,
  };
}
