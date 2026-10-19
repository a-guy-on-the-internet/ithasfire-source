import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ADMIN_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

const IDEMPOTENCY_TTL_SECONDS = 300;

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const migrateEventOrdersInputSchema = z.object({
  actorHumanId: z.uuid(),
  sourceEventId: z.uuid(),
  targetEventId: z.uuid(),
  clientKey: z.string().min(8),
});

export const migrateEventOrdersOutputSchema = z.object({
  migratedOrderCount: z.number().int().nonnegative(),
  migratedTicketCount: z.number().int().nonnegative(),
  migratedOrderIds: z.array(z.string()),
  sourceEventId: z.uuid(),
  targetEventId: z.uuid(),
});

export type MigrateEventOrdersInput = z.infer<
  typeof migrateEventOrdersInputSchema
>;
export type MigrateEventOrdersOutput = z.infer<
  typeof migrateEventOrdersOutputSchema
>;

export type MigrateEventOrdersDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredMigrateRecord {
  payloadHash: string;
  response: MigrateEventOrdersOutput;
}

// ─── Use case ────────────────────────────────────────────────────────────────

export async function migrateEventOrders(
  deps: MigrateEventOrdersDeps,
  rawInput: unknown,
): Promise<MigrateEventOrdersOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "migrateEventOrders" });

  const execute = async () => {
    const input = parseInput(migrateEventOrdersInputSchema, rawInput);

    if (input.sourceEventId === input.targetEventId) {
      throw fail("SOURCE_AND_TARGET_MUST_DIFFER");
    }

    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    // ── Idempotency: replay ──────────────────────────────────────────────
    const replay =
      await deps.idempotency.get<StoredMigrateRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredMigrateRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      // ── 1. Load and validate both events ─────────────────────────────
      const [sourceEvent, targetEvent] = await Promise.all([
        deps.repos.events.getById(input.sourceEventId),
        deps.repos.events.getById(input.targetEventId),
      ]);

      if (!sourceEvent) {
        throw fail("EVENT_NOT_FOUND", { meta: { role: "source" } });
      }
      if (!targetEvent) {
        throw fail("EVENT_NOT_FOUND", { meta: { role: "target" } });
      }

      // ── 2. Same-owner check ──────────────────────────────────────────
      ensureSameOwner(sourceEvent, targetEvent);

      // ── 3. Target must be active ─────────────────────────────────────
      ensureTargetActive(targetEvent);

      // ── 4. RBAC ──────────────────────────────────────────────────────
      await ensureActorAuthorized(deps.repos, input.actorHumanId, sourceEvent);

      // ── 5. Check source has orders ───────────────────────────────────
      const sourceOrders = await deps.repos.orders.listAll({
        eventId: input.sourceEventId,
        statuses: ["SUCCEEDED", "PROCESSING"],
        limit: 1,
      });

      if (sourceOrders.total === 0) {
        throw fail("NO_ORDERS_TO_MIGRATE");
      }

      // ── 6. Build ticket type mapping ─────────────────────────────────
      const [sourceTicketTypes, targetTicketTypes] = await Promise.all([
        deps.repos.events.listTicketTypes(input.sourceEventId),
        deps.repos.events.listTicketTypes(input.targetEventId),
      ]);

      const ticketTypeMapping = buildTicketTypeMapping(
        sourceTicketTypes,
        targetTicketTypes,
      );

      // ── 7. Capacity check ────────────────────────────────────────────
      const sourceTicketCount = await deps.repos.tickets.countIssuedForEvent(
        input.sourceEventId,
      );
      const targetIssuedCount = await deps.repos.tickets.countIssuedForEvent(
        input.targetEventId,
      );
      const targetTotalCapacity = targetTicketTypes.reduce(
        (sum, tt) => sum + tt.capacity,
        0,
      );

      if (
        targetTotalCapacity > 0 &&
        targetIssuedCount + sourceTicketCount > targetTotalCapacity
      ) {
        throw fail("INSUFFICIENT_CAPACITY");
      }

      // ── 8. Transaction: migrate orders + tickets ─────────────────────
      const result = await deps.repos.tx(async (tx) => {
        const now = deps.clock.now();

        // 8a. Migrate orders
        const orderResult = await tx.orders.bulkMigrateToEvent({
          sourceEventId: input.sourceEventId,
          targetEventId: input.targetEventId,
          statuses: ["SUCCEEDED", "PROCESSING"],
        });

        // 8b. Migrate tickets
        const ticketResult = await tx.tickets.bulkMigrateToEvent({
          sourceEventId: input.sourceEventId,
          targetEventId: input.targetEventId,
          ticketTypeMapping,
          regenerateCodes: true,
        });

        // 8c. Audit log
        await tx.audit.log({
          entity: "event",
          entityId: input.sourceEventId,
          action: "orders_migrated",
          data: {
            targetEventId: input.targetEventId,
            actorHumanId: input.actorHumanId,
            orderCount: orderResult.updatedCount,
            ticketCount: ticketResult.updatedCount,
            migratedOrderIds: orderResult.migratedOrderIds,
          },
          at: now,
        });

        return migrateEventOrdersOutputSchema.parse({
          migratedOrderCount: orderResult.updatedCount,
          migratedTicketCount: ticketResult.updatedCount,
          migratedOrderIds: orderResult.migratedOrderIds,
          sourceEventId: input.sourceEventId,
          targetEventId: input.targetEventId,
        });
      });

      // ── 9. Commit idempotency ────────────────────────────────────────
      await deps.idempotency.commit<StoredMigrateRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("migrate_event_orders", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("migrateEventOrders", execute);
  }

  return execute();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Also used by sendMigrationNotification (security review F15). */
export function ensureSameOwner(
  source: EventRecord,
  target: EventRecord,
): void {
  if (source.orgId && target.orgId) {
    if (source.orgId !== target.orgId) {
      throw fail("EVENTS_DIFFERENT_ORG");
    }
    return;
  }

  if (source.humanId && target.humanId) {
    if (source.humanId !== target.humanId) {
      throw fail("EVENTS_DIFFERENT_OWNER");
    }
    return;
  }

  // One is org-owned, the other is human-owned.
  throw fail("EVENTS_DIFFERENT_OWNER");
}

function ensureTargetActive(target: EventRecord): void {
  const activeStatuses = new Set(["DRAFT", "PUBLISHED"]);
  if (!activeStatuses.has(target.status)) {
    throw fail("TARGET_EVENT_NOT_ACTIVE");
  }
}

async function ensureActorAuthorized(
  repos: Repos,
  actorHumanId: string,
  event: EventRecord,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    // The owner, or an OWNER/ADMIN delegate (owner ruling 2026-09-28).
    await ensureActorHoldsHumanEventRole(
      repos.authz,
      event.humanId,
      actorHumanId,
      ORG_ADMIN_ROLES,
    );
  }
}

/**
 * Try to match source ticket types to target ticket types by name.
 * Returns a mapping of sourceTypeId → targetTypeId.
 */
function buildTicketTypeMapping(
  sourceTypes: Array<{ id: string; name: string }>,
  targetTypes: Array<{ id: string; name: string }>,
): Record<string, string> {
  const targetByName = new Map(
    targetTypes.map((tt) => [tt.name.toLowerCase(), tt.id]),
  );
  const mapping: Record<string, string> = {};

  for (const st of sourceTypes) {
    const match = targetByName.get(st.name.toLowerCase());
    if (match) {
      mapping[st.id] = match;
    }
    // If no match, the ticket keeps its original typeId.
    // The adapter handles this by not changing the typeId.
  }

  return mapping;
}

function buildPayloadHash(input: MigrateEventOrdersInput): string {
  return JSON.stringify({
    sourceEventId: input.sourceEventId,
    targetEventId: input.targetEventId,
  });
}

function buildIdempotencyKey(input: MigrateEventOrdersInput): string {
  return `migrate-orders:${input.sourceEventId}:${input.targetEventId}:${input.clientKey}`;
}
