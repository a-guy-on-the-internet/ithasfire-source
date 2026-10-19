import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";

// ── Schema ───────────────────────────────────────────────────────────────────

export const unpairPosReaderInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  posReaderId: z.string().uuid(),
});

export type UnpairPosReaderInput = z.infer<typeof unpairPosReaderInputSchema>;

export const unpairPosReaderOutputSchema = z.object({
  unpaired: z.literal(true),
});

export type UnpairPosReaderOutput = z.infer<typeof unpairPosReaderOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type UnpairPosReaderDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Releases a reader: deregisters it at Stripe and drops our ownership row.
 *
 * Auth: ORG_ADMIN_ROLES, matching `pairPosReader`.
 *
 * Order matters. Stripe is deregistered FIRST, then our row is deleted. The
 * failure modes are asymmetric:
 *   - Stripe deleted, row kept (our delete fails) → the org sees a reader that
 *     no longer works, and can retry the unpair. Annoying, recoverable.
 *   - Row deleted, Stripe kept (the other order) → a live platform reader with
 *     no owner. Any org could then claim it while it is still physically
 *     sitting on someone's counter. Not acceptable.
 *
 * A reader Stripe has already forgotten (404) is treated as success — the end
 * state the operator asked for is "this reader is gone", and it is.
 */
export async function unpairPosReader(
  deps: UnpairPosReaderDeps,
  rawInput: unknown,
): Promise<UnpairPosReaderOutput> {
  const input = parseInput(unpairPosReaderInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const reader = await deps.repos.posReaders.getById({ id: input.posReaderId });
  if (!reader) {
    throw fail("POS_READER_NOT_FOUND");
  }
  // Ownership check. POS_READER_ORG_MISMATCH maps to NOT_FOUND at the
  // transport boundary so this is indistinguishable from a bad id.
  if (reader.orgId !== input.orgId) {
    throw fail("POS_READER_ORG_MISMATCH");
  }

  try {
    await deps.payments.deleteTerminalReader({
      readerId: reader.stripeReaderId,
    });
  } catch (err) {
    if (!isAlreadyGone(err)) {
      throw err;
    }
    deps.logger?.warn("pos.reader.unpair_already_deregistered", {
      posReaderId: reader.id,
      stripeReaderId: reader.stripeReaderId,
    });
  }

  await deps.repos.posReaders.delete({ id: reader.id });

  await deps.repos.audit.log({
    entity: "pos_reader",
    entityId: reader.id,
    action: "pos.reader.unpaired",
    at: deps.clock.now(),
    data: {
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      stripeReaderId: reader.stripeReaderId,
      label: reader.label,
    },
  });

  deps.logger?.info("pos.reader.unpaired", {
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    posReaderId: reader.id,
    stripeReaderId: reader.stripeReaderId,
  });
  deps.metrics?.increment("pos.unpair_reader.success", { orgId: input.orgId });

  return unpairPosReaderOutputSchema.parse({ unpaired: true });
}

function isAlreadyGone(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const e = err as { statusCode?: unknown; code?: unknown };
  return e.statusCode === 404 || e.code === "resource_missing";
}
