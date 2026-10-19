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
import { ensurePlatformTerminalLocation } from "./ensure-platform-terminal-location";

// ── Schema ───────────────────────────────────────────────────────────────────

export const pairPosReaderInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  /**
   * The short code the reader displays in its settings screen. Stripe's codes
   * are hyphenated words (e.g. "puppies-plug-could"); we normalise case and
   * surrounding whitespace but otherwise pass through untouched so a future
   * code format doesn't need a schema change.
   */
  registrationCode: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(64),
  label: z.string().trim().min(1).max(64),
  /** Optional venue pin so the Sell screen can default the picker. */
  placeId: z.string().uuid().nullish(),
});

export type PairPosReaderInput = z.infer<typeof pairPosReaderInputSchema>;

export const pairPosReaderOutputSchema = z.object({
  id: z.string().uuid(),
  stripeReaderId: z.string(),
  label: z.string(),
  placeId: z.string().nullable(),
  deviceType: z.string().nullable(),
  status: z.enum(["online", "offline"]).nullable(),
});

export type PairPosReaderOutput = z.infer<typeof pairPosReaderOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type PairPosReaderDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Claims a physical Stripe Terminal reader for an org.
 *
 * Two-sided registration:
 *   1. Stripe side — the registration code is exchanged for a `tmr_xxx` on the
 *      PLATFORM account, bound to the single platform Terminal Location. This
 *      is an ownership claim at Stripe, not a network connection; the reader
 *      keeps talking only to Stripe and never to us.
 *   2. Our side — a `pos_readers` row records which ORG owns it. Stripe has no
 *      such concept, so this row is the only thing standing between org A and
 *      org B's hardware. Every reader-driving use case re-checks it.
 *
 * Auth: ORG_ADMIN_ROLES. Pairing hardware binds physical money-collection
 * capability to the org, which is an owner/admin decision — not something an
 * EDITOR or a door volunteer with SCANNER should be able to do.
 *
 * Not idempotent by design: a registration code is single-use at Stripe, so a
 * double-submit fails on the Stripe call rather than silently creating a
 * second row.
 */
export async function pairPosReader(
  deps: PairPosReaderDeps,
  rawInput: unknown,
): Promise<PairPosReaderOutput> {
  const input = parseInput(pairPosReaderInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  // A venue pin is cosmetic, but a bogus/foreign placeId shouldn't be
  // persisted — verify it resolves before we take the Stripe side-effect.
  if (input.placeId) {
    const place = await deps.repos.places.getById(input.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }
  }

  const location = await ensurePlatformTerminalLocation({
    repos: deps.repos,
    payments: deps.payments,
    logger: deps.logger,
  });

  let registered: {
    readerId: string;
    deviceType: string | null;
    status: "online" | "offline" | null;
  };
  try {
    registered = await deps.payments.registerTerminalReader({
      registrationCode: input.registrationCode,
      label: input.label,
      locationId: location.locationId,
    });
  } catch (err) {
    if (isRegistrationCodeError(err)) {
      deps.metrics?.increment("pos.pair_reader.invalid_code", {
        orgId: input.orgId,
      });
      throw fail("POS_READER_REGISTRATION_CODE_INVALID");
    }
    throw err;
  }

  // Stripe accepted the code, so this hardware is now registered to the
  // platform. If OUR row can't be written we must not leave it dangling —
  // an unowned platform reader is exactly the ambiguity this table exists to
  // prevent — so deregister before surfacing the error.
  const existing = await deps.repos.posReaders.getByStripeReaderId({
    stripeReaderId: registered.readerId,
  });
  if (existing) {
    await deregisterQuietly(deps, registered.readerId);
    throw fail("POS_READER_ALREADY_PAIRED");
  }

  let reader;
  try {
    reader = await deps.repos.posReaders.create({
      orgId: input.orgId,
      stripeReaderId: registered.readerId,
      label: input.label,
      placeId: input.placeId ?? null,
      deviceType: registered.deviceType,
      pairedByHumanId: input.actorHumanId,
    });
  } catch (err) {
    await deregisterQuietly(deps, registered.readerId);
    throw err;
  }

  await deps.repos.audit.log({
    entity: "pos_reader",
    entityId: reader.id,
    action: "pos.reader.paired",
    at: deps.clock.now(),
    data: {
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      stripeReaderId: registered.readerId,
      label: input.label,
      deviceType: registered.deviceType,
      placeId: input.placeId ?? null,
    },
  });

  deps.logger?.info("pos.reader.paired", {
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    posReaderId: reader.id,
    stripeReaderId: registered.readerId,
    // intentionally NOT logging the registration code
  });
  deps.metrics?.increment("pos.pair_reader.success", { orgId: input.orgId });

  return pairPosReaderOutputSchema.parse({
    id: reader.id,
    stripeReaderId: reader.stripeReaderId,
    label: reader.label,
    placeId: reader.placeId,
    deviceType: reader.deviceType,
    status: registered.status,
  });
}

function isRegistrationCodeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isRegistrationCodeError?: unknown }).isRegistrationCodeError ===
      true
  );
}

/**
 * Best-effort Stripe deregistration on a failed pair. Swallows its own errors
 * so the caller sees the ORIGINAL failure, which is the one that explains what
 * went wrong; a leaked platform reader is recoverable from the Stripe
 * dashboard, a swapped error message is not.
 */
async function deregisterQuietly(
  deps: PairPosReaderDeps,
  readerId: string,
): Promise<void> {
  try {
    await deps.payments.deleteTerminalReader({ readerId });
  } catch (cleanupErr) {
    deps.logger?.error("pos.reader.pair_rollback_failed", {
      stripeReaderId: readerId,
      err: cleanupErr,
    });
  }
}
