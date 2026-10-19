import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

import { describeError, parseInput } from "../../lib/io";
import {
  requireOrgMembership,
  ORG_ADMIN_ROLES,
  ORG_EDIT_ROLES,
} from "../../lib/rbac";
import { generateEventSlug } from "./_shared/slug";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { markForSearchReindex } from "../search/search-reindex-marks";

const IDEMPOTENCY_TTL_SECONDS = 120;

export const regenerateEventSlugInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    clientKey: z.string().min(8),
  })
  .strict();

export const regenerateEventSlugOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    newSlug: z.string().min(1),
    previousSlug: z.string().min(1),
  })
  .strict();

export type RegenerateEventSlugInput = z.infer<
  typeof regenerateEventSlugInputSchema
>;
export type RegenerateEventSlugOutput = z.infer<
  typeof regenerateEventSlugOutputSchema
>;

type StoredRegenerateSlugRecord = {
  payloadHash: string;
  response: RegenerateEventSlugOutput;
};

export type RegenerateEventSlugDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function regenerateEventSlug(
  deps: RegenerateEventSlugDeps,
  rawInput: unknown,
): Promise<RegenerateEventSlugOutput> {
  const input = parseInput(regenerateEventSlugInputSchema, rawInput);
  const payloadHash = buildPayloadHash(input);
  const idempotencyKey = buildIdempotencyKey(input.eventId, input.clientKey);

  const replay =
    await deps.idempotency.get<StoredRegenerateSlugRecord>(idempotencyKey);
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
      await deps.idempotency.get<StoredRegenerateSlugRecord>(idempotencyKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();
      const event = await ensureEventSlugRegenerationPermitted(
        tx,
        input.eventId,
        input.actorHumanId,
      );

      if (!event.slug) {
        throw fail("EVENT_SLUG_MISSING");
      }

      const previousSlug = event.slug;
      const slugContext = await tx.events.getSlugContext(event.id);
      if (!slugContext) {
        throw fail("EVENT_SLUG_CONTEXT_MISSING");
      }

      const generated = generateEventSlug(slugContext);

      if (generated.slug === previousSlug) {
        return regenerateEventSlugOutputSchema.parse({
          eventId: event.id,
          newSlug: previousSlug,
          previousSlug,
        });
      }

      await tx.events.recordSlugHistory({
        eventId: event.id,
        slug: previousSlug,
        recordedAt: now,
      });

      let updated: EventRecord;
      try {
        updated = await tx.events.updateSlug({
          eventId: event.id,
          slug: generated.slug,
          regionCode: generated.regionCode,
          updatedAt: now,
        });
      } catch (error) {
        throw mapSlugUpdateError(error);
      }

      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "event.slug_regenerated",
        data: {
          previousSlug,
          newSlug: generated.slug,
        },
        at: now,
      });

      // A published event's document links by slug.
      if (updated.status === "PUBLISHED") {
        await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
      }

      deps.logger?.info("event.slug_regenerated", {
        eventId: event.id,
        newSlug: generated.slug,
        previousSlug,
      });

      return regenerateEventSlugOutputSchema.parse({
        eventId: updated.id,
        newSlug: generated.slug,
        previousSlug,
      });
    });

    await deps.idempotency.commit<StoredRegenerateSlugRecord>(idempotencyKey, {
      payloadHash,
      response: result,
    });

    return result;
  } catch (error) {
    await deps.idempotency.fail(idempotencyKey, describeError(error));
    throw error;
  }
}

async function ensureEventSlugRegenerationPermitted(
  tx: TxRepos,
  eventId: string,
  actorHumanId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (!isSlugRegenerationStatusAllowed(event.status)) {
    throw fail("EVENT_SLUG_REGENERATION_NOT_ALLOWED");
  }

  const allowedRoles =
    event.status === "PUBLISHED" ? ORG_ADMIN_ROLES : ORG_EDIT_ROLES;
  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: allowedRoles,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else if (event.humanId) {
    // Same role set as the org arm, applied to the owner's delegates.
    await ensureActorHoldsHumanEventRole(
      tx.authz,
      event.humanId,
      actorHumanId,
      allowedRoles,
    );
  } else {
    throw fail("HUMAN_NOT_FOUND", { meta: { role: "event_owner" }, category: "FORBIDDEN" });
  }

  return event;
}

function isSlugRegenerationStatusAllowed(
  status: EventRecord["status"],
): boolean {
  return status === "DRAFT" || status === "PUBLISHED";
}

export function mapSlugUpdateError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    if (code === "conflict") {
      // Preserve the repo error as `cause` so trpc's toTrpcError forwards it
      // to Sentry's linkedErrors integration. The repo's `{code: "conflict"}`
      // carries the PrismaClientKnownRequestError as ITS cause (see
      // `handleSlugConstraintError`), so the chain reaches the constraint and
      // row that actually failed.
      return {
        code: "conflict",
        message: "event_slug_conflict",
        cause: error,
      } as const;
    }
  }

  return error;
}

function buildPayloadHash(input: RegenerateEventSlugInput): string {
  return JSON.stringify({
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
  });
}

function buildIdempotencyKey(eventId: string, clientKey: string): string {
  return `event:slug:regenerate:${eventId}:${clientKey}`;
}
