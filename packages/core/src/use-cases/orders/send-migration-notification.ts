import { z } from "zod";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ADMIN_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { ensureSameOwner } from "./migrate-event-orders";

/**
 * Most order ids one call may name. Each id costs an order read; without a cap
 * the 10 MiB body limit admitted hundreds of thousands (security review F15).
 * The web client batches a larger migration into calls of this size.
 */
export const MAX_MIGRATION_NOTIFY_ORDER_IDS = 500;

export const sendMigrationNotificationInputSchema = z.object({
  actorHumanId: z.uuid(),
  sourceEventId: z.uuid(),
  targetEventId: z.uuid(),
  migratedOrderIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_MIGRATION_NOTIFY_ORDER_IDS),
  publicAppUrl: z.string().url(),
});

export const sendMigrationNotificationOutputSchema = z.object({
  ok: z.literal(true),
  sentCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});

export type SendMigrationNotificationInput = z.infer<
  typeof sendMigrationNotificationInputSchema
>;
export type SendMigrationNotificationOutput = z.infer<
  typeof sendMigrationNotificationOutputSchema
>;

export type SendMigrationNotificationDeps = {
  repos: Repos;
  mailer: MailerPort;
  logger?: LoggerPort;
  /** Reports a swallowed per-buyer send failure (CLAUDE.md convention). */
  reportError?: ReporterPort;
};

export async function sendMigrationNotification(
  deps: SendMigrationNotificationDeps,
  rawInput: unknown,
): Promise<SendMigrationNotificationOutput> {
  const input = parseInput(sendMigrationNotificationInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "sendMigrationNotification" });

  const [sourceEvent, targetEvent] = await Promise.all([
    deps.repos.events.getById(input.sourceEventId),
    deps.repos.events.getById(input.targetEventId),
  ]);

  if (!sourceEvent || !targetEvent) {
    throw fail("EVENT_NOT_FOUND");
  }

  // ── RBAC: actor must own the source event ──
  if (sourceEvent.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: sourceEvent.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    // The owner, or an OWNER/ADMIN delegate (owner ruling 2026-09-28).
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      sourceEvent.humanId,
      input.actorHumanId,
      ORG_ADMIN_ROLES,
    );
  }

  // The actor is authorized on the SOURCE only, so the target must share its
  // owner — the same rule migrateEventOrders enforces (security review F15).
  // Without it the email names any event as the "new date".
  ensureSameOwner(sourceEvent, targetEvent);

  const publicAppUrl = input.publicAppUrl.replace(/\/+$/, "");

  let sentCount = 0;
  let failedCount = 0;

  // ── Phase 1: collect orders and deduplicate by buyer ──
  // Maps buyerHumanId → first orderId (used for the manage URL).
  const buyerOrderMap = new Map<string, string>();

  for (const orderId of new Set(input.migratedOrderIds)) {
    const order = await deps.repos.orders.getById(orderId);
    // A migrated order now lives on the TARGET event. Any other order id —
    // missing, still on the source, or someone else's — is skipped, so the
    // caller cannot mail arbitrary buyers (security review F15).
    if (!order || order.eventId !== input.targetEventId) {
      logger?.warn("sendMigrationNotification.order_not_on_target", {
        orderId,
      });
      failedCount++;
      continue;
    }
    // Keep the first orderId per buyer for the manage URL
    if (!buyerOrderMap.has(order.buyerHumanId)) {
      buyerOrderMap.set(order.buyerHumanId, orderId);
    }
  }

  // ── Phase 2: batch-resolve buyer identities (parallel) ──
  const buyerIds = [...buyerOrderMap.keys()];
  const identityResults = await Promise.all(
    buyerIds.map((id) => deps.repos.humans.getByIdWithIdentity(id)),
  );

  const identityMap = new Map(
    buyerIds
      .map((id, i) => [id, identityResults[i]] as const)
      .filter(
        (pair): pair is [string, NonNullable<(typeof pair)[1]>] =>
          pair[1] != null,
      ),
  );

  // Count buyers we couldn't resolve
  const missingBuyers = buyerIds.length - identityMap.size;
  if (missingBuyers > 0) {
    logger?.warn("sendMigrationNotification.buyers_not_found", {
      count: missingBuyers,
    });
    failedCount += missingBuyers;
  }

  // ── Phase 3: send emails ──
  for (const [buyerHumanId, human] of identityMap) {
    const orderId = buyerOrderMap.get(buyerHumanId)!;
    const manageUrl = `${publicAppUrl}/orders/${orderId}`;

    try {
      await deps.mailer.send({
        to: { to: human.identity.email },
        template: {
          key: "event.rescheduled",
          variables: {
            sourceEventTitle: sourceEvent.title,
            sourceEventDateISO: sourceEvent.startsAt.toISOString(),
            targetEventTitle: targetEvent.title,
            targetEventDateISO: targetEvent.startsAt.toISOString(),
            // Each date renders in its own event's zone, not the server's
            // (UTC on Cloud Run, where a 7pm Chicago show is the next day).
            sourceEventTimezone: sourceEvent.timezone,
            targetEventTimezone: targetEvent.timezone,
            manageUrl,
          },
        },
        idempotencyKey: `migration-notify:${input.sourceEventId}:${input.targetEventId}:${buyerHumanId}`,
      });
      sentCount++;
    } catch (error) {
      logger?.error("sendMigrationNotification.send_failed", {
        buyerHumanId,
        orderId,
        error,
      });
      // Swallowed per buyer so the rest still go out — report it.
      try {
        deps.reportError?.(error, {
          tags: { useCase: "sendMigrationNotification" },
          extra: { orderId, targetEventId: input.targetEventId },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
      failedCount++;
    }
  }

  logger?.info("sendMigrationNotification.complete", {
    sentCount,
    failedCount,
  });

  return sendMigrationNotificationOutputSchema.parse({
    ok: true,
    sentCount,
    failedCount,
  });
}
