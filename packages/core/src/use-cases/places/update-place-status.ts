import { createHash } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PlaceRecord, PlaceStatus, Repos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { markForSearchReindex } from "../search/search-reindex-marks";

const PLACE_STATUS_VALUES = [
  "ACTIVE",
  "SUSPENDED",
  "ARCHIVED",
] as const satisfies readonly PlaceStatus[];

export const updatePlaceStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    /**
     * Desired target status for the place.
     *
     * NOTE: This use case is intended for owners/admin tooling. Public listing should continue
     * to exclude ARCHIVED places.
     */
    status: z.enum(PLACE_STATUS_VALUES),
    clientKey: z.string().min(8),
  })
  .strict();

export const updatePlaceStatusOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    status: z.enum(PLACE_STATUS_VALUES),
  })
  .strict();

export type UpdatePlaceStatusInput = z.infer<
  typeof updatePlaceStatusInputSchema
>;
export type UpdatePlaceStatusOutput = z.infer<
  typeof updatePlaceStatusOutputSchema
>;

export type UpdatePlaceStatusDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

type StoredUpdatePlaceStatusRecord = {
  payloadHash: string;
  response: UpdatePlaceStatusOutput;
};

export async function updatePlaceStatus(
  deps: UpdatePlaceStatusDeps,
  rawInput: unknown,
): Promise<UpdatePlaceStatusOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updatePlaceStatus" });

  const execute = async () => {
    const input = parseInput(updatePlaceStatusInputSchema, rawInput);
    return handleUpdatePlaceStatus(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updatePlaceStatus", execute);
  }
  return execute();
}

async function handleUpdatePlaceStatus(
  deps: UpdatePlaceStatusDeps,
  logger: LoggerPort | undefined,
  input: UpdatePlaceStatusInput,
): Promise<UpdatePlaceStatusOutput> {
  const existing = await deps.repos.places.getById(input.placeId);
  if (!existing) {
    throw fail("PLACE_NOT_FOUND");
  }

  await ensureActorHasOwnerAccess(deps.repos, input.actorHumanId, existing);

  if (existing.status === input.status) {
    return updatePlaceStatusOutputSchema.parse({
      placeId: existing.id,
      status: existing.status,
    });
  }

  const payloadHash = buildPayloadHash({
    placeId: input.placeId,
    status: input.status,
  });
  const idemKey = buildIdempotencyKey(input.placeId, input.clientKey);

  const replay =
    await deps.idempotency.get<StoredUpdatePlaceStatusRecord>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const claimed = await deps.idempotency.begin(idemKey, 300);
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredUpdatePlaceStatusRecord>(idemKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const at = deps.clock.now();

    const from = await deps.repos.tx(async (tx) => {
      // The claim lock serialises this with claim submit / review, the
      // verification flips and the community-moderator archive / restore,
      // which all take it. The owner check and the CAS's `from` come from a
      // read under it, so an ownership revoked meanwhile is refused and the
      // audit's `from` is the status this call actually replaced.
      await tx.places.lockPlaceForClaim(input.placeId);
      const current = await tx.places.getById(input.placeId);
      if (!current) {
        throw fail("PLACE_NOT_FOUND");
      }
      await ensureActorHasOwnerAccess(tx, input.actorHumanId, current);
      // Already there (another writer got here first): the outcome this call
      // asked for, so no write, no audit row and no mark, like the early
      // return above.
      if (current.status === input.status) {
        return null;
      }

      // Compare-and-set of `status` alone. It used to rebuild the whole row
      // through `places.upsert`, which overwrote a concurrent name/address
      // edit and wrote a NULL street line / country back as "" / "US".
      const { changed } = await tx.places.compareAndSetStatus({
        placeId: current.id,
        from: current.status,
        to: input.status,
      });
      if (!changed) {
        // A writer that skips the claim lock moved the status between the
        // read and the write. At the target: same outcome as above. Anything
        // else is refused, never written over (CONFLICT shows the "refresh
        // and try again" copy).
        const after = await tx.places.getById(current.id);
        if (after?.status === input.status) {
          return null;
        }
        throw fail("CONFLICT", {
          meta: {
            reason: "place_status_changed",
            placeId: current.id,
            expected: current.status,
          },
        });
      }

      await tx.audit.log({
        entity: "place",
        entityId: current.id,
        action: "status_updated",
        data: {
          actorHumanId: input.actorHumanId,
          from: current.status,
          to: input.status,
        },
        at,
      });

      // The place's search document shows its status/verification (a
      // non-ACTIVE place is removed from search by the reindex).
      await markForSearchReindex(tx, [{ kind: "place", id: current.id }], at);

      return current.status;
    });

    const response = updatePlaceStatusOutputSchema.parse({
      placeId: existing.id,
      status: input.status,
    });

    logger?.info("places.update_status", {
      actorHumanId: input.actorHumanId,
      placeId: input.placeId,
      // null: the place already held the status under the lock (no write).
      from: from ?? input.status,
      to: response.status,
      changed: from !== null,
    });

    await deps.idempotency.commit<StoredUpdatePlaceStatusRecord>(idemKey, {
      payloadHash,
      response,
    });
    return response;
  } catch (error) {
    await deps.idempotency.fail(idemKey, describeError(error));
    throw asKnownError("update_place_status", error);
  }
}

async function ensureActorHasOwnerAccess(
  repos: Pick<Repos, "authz">,
  actorHumanId: string,
  place: PlaceRecord,
): Promise<void> {
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return;
  }

  // For org-owned places, ensure the actor is a member of at least one owning org.
  const orgIds = place.orgIdsWithAccess;
  if (orgIds.length === 0) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  const memberships = await Promise.all(
    orgIds.map(async (orgId) => {
      const m = await repos.authz.getOrgMembership({
        orgId,
        humanId: actorHumanId,
      });
      return m ?? null;
    }),
  );

  const hasMembership = memberships.some(Boolean);
  if (!hasMembership) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }
}

function buildIdempotencyKey(placeId: string, clientKey: string): string {
  return `places.update-status.${placeId}.${clientKey}`;
}

function buildPayloadHash(input: {
  placeId: string;
  status: PlaceStatus;
}): string {
  const payload = JSON.stringify({
    placeId: input.placeId,
    status: input.status,
  });
  return createHash("sha256").update(payload).digest("hex");
}
