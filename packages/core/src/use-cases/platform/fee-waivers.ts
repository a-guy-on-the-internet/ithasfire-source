import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { FeeWaiverRecord } from "@th/types";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes
// ─────────────────────────────────────────────────────────────────────────────

const subjectTypeSchema = z.enum(["HUMAN", "ORG"]);
const sideSchema = z.enum(["ORGANIZER", "BUYER"]);

export const feeWaiverOutputSchema = z.object({
  id: z.string(),
  subjectType: subjectTypeSchema,
  subjectId: z.string(),
  /**
   * Best-effort display name for the subject. Null when the human/org lookup
   * misses — a waiver stays valid even if its subject was renamed or removed,
   * so this never blocks the list.
   */
  subjectLabel: z.string().nullable(),
  side: sideSchema,
  ticketsGranted: z.number().int(),
  ticketsUsed: z.number().int(),
  ticketsRemaining: z.number().int(),
  status: z.enum(["ACTIVE", "EXHAUSTED", "REVOKED"]),
  effectiveFrom: z.date(),
  effectiveTo: z.date().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  revokedBy: z.string().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});

export type FeeWaiverOutput = z.infer<typeof feeWaiverOutputSchema>;

export type FeeWaiverDeps = {
  repos: Pick<Repos, "feeWaivers" | "humans" | "organizations">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
  /** Reports the best-effort subject-label lookup failure. */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: FeeWaiverDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

/**
 * Resolves display names for a page of waivers in two batched lookups.
 *
 * Deliberately swallows: a naming lookup must never take down the admin list,
 * and a waiver whose subject was deleted still needs to be visible so staff can
 * revoke it. Reports so the failure is not silent.
 */
async function attachSubjectLabels(
  deps: FeeWaiverDeps,
  waivers: FeeWaiverRecord[],
): Promise<FeeWaiverOutput[]> {
  const labels = new Map<string, string>();

  try {
    const humanIds = waivers
      .filter((w) => w.subjectType === "HUMAN")
      .map((w) => w.subjectId);
    const orgIds = waivers
      .filter((w) => w.subjectType === "ORG")
      .map((w) => w.subjectId);

    const [humans, orgs] = await Promise.all([
      humanIds.length > 0 ? deps.repos.humans.getByIds(humanIds) : [],
      orgIds.length > 0 ? deps.repos.organizations.getByIds(orgIds) : [],
    ]);

    for (const human of humans) {
      if (human.name) labels.set(`HUMAN:${human.id}`, human.name);
    }
    for (const org of orgs) {
      const label = org.name || org.slug;
      if (label) labels.set(`ORG:${org.id}`, label);
    }
  } catch (err) {
    deps.logger?.error("fee_waiver_subject_label_lookup_failed", { err });
    deps.reportError?.(err, {
      tags: { useCase: "listFeeWaivers", step: "attachSubjectLabels" },
    });
  }

  return waivers.map((w) => ({
    id: w.id,
    subjectType: w.subjectType,
    subjectId: w.subjectId,
    subjectLabel: labels.get(`${w.subjectType}:${w.subjectId}`) ?? null,
    side: w.side,
    ticketsGranted: w.ticketsGranted,
    ticketsUsed: w.ticketsUsed,
    ticketsRemaining: w.ticketsRemaining,
    status: w.status,
    effectiveFrom: w.effectiveFrom,
    effectiveTo: w.effectiveTo,
    notes: w.notes,
    createdBy: w.createdBy,
    revokedBy: w.revokedBy,
    revokedAt: w.revokedAt,
    createdAt: w.createdAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────────────────────

export const listFeeWaiversInputSchema = z
  .object({
    actorHumanId: z.string(),
    subjectType: subjectTypeSchema.optional(),
    subjectId: z.string().optional(),
    side: sideSchema.optional(),
    /** Include EXHAUSTED and REVOKED rows. Defaults to ACTIVE only. */
    includeInactive: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();

export const listFeeWaiversOutputSchema = z
  .object({
    waivers: z.array(feeWaiverOutputSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ListFeeWaiversInput = z.infer<typeof listFeeWaiversInputSchema>;
export type ListFeeWaiversOutput = z.infer<typeof listFeeWaiversOutputSchema>;

export async function listFeeWaivers(
  deps: FeeWaiverDeps,
  rawInput: unknown,
): Promise<ListFeeWaiversOutput> {
  const input = parseInput(listFeeWaiversInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const { waivers, total } = await deps.repos.feeWaivers.list({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    side: input.side,
    includeInactive: input.includeInactive,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    waivers: await attachSubjectLabels(deps, waivers),
    total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unrefined base. Transport omits `actorHumanId` from THIS one — Zod refuses
 * `.omit()` on a schema carrying a `.refine()`. The date-order check still runs
 * server-side because the use case parses the refined schema below.
 */
export const grantFeeWaiverInputSchemaBase = z
  .object({
    actorHumanId: z.string(),
    subjectType: subjectTypeSchema,
    subjectId: z.uuid(),
    side: sideSchema,
    /**
     * Ticket count the allowance covers. Capped at 100k — a fat-fingered grant
     * is real forgone revenue, and nothing legitimate needs more.
     */
    ticketsGranted: z.number().int().min(1).max(100_000),
    effectiveFrom: z.date().nullable().default(null),
    effectiveTo: z.date().nullable().default(null),
    notes: z.string().max(500).nullable().default(null),
  })
  .strict();

export const grantFeeWaiverInputSchema = grantFeeWaiverInputSchemaBase.refine(
  (v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveTo > v.effectiveFrom,
  {
    message: "effectiveTo must be after effectiveFrom",
    path: ["effectiveTo"],
  },
);

export const grantFeeWaiverOutputSchema = z
  .object({ waiver: feeWaiverOutputSchema })
  .strict();

export type GrantFeeWaiverInput = z.infer<typeof grantFeeWaiverInputSchema>;
export type GrantFeeWaiverOutput = z.infer<typeof grantFeeWaiverOutputSchema>;

export async function grantFeeWaiver(
  deps: FeeWaiverDeps,
  rawInput: unknown,
): Promise<GrantFeeWaiverOutput> {
  const logger = deps.logger?.child({ useCase: "grantFeeWaiver" });
  const input = parseInput(grantFeeWaiverInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  // Reject a grant against a subject that does not exist — otherwise a typo'd
  // id creates an allowance that silently never applies to anyone.
  const subjectExists =
    input.subjectType === "HUMAN"
      ? Boolean(await deps.repos.humans.getById(input.subjectId))
      : Boolean(await deps.repos.organizations.getById(input.subjectId));

  if (!subjectExists) {
    throw fail("NOT_FOUND", {
      message: `No ${input.subjectType.toLowerCase()} with id ${input.subjectId}`,
    });
  }

  const record = await deps.repos.feeWaivers.grant({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    side: input.side,
    ticketsGranted: input.ticketsGranted,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    notes: input.notes,
    actorHumanId: input.actorHumanId,
  });

  logger?.info("fee_waiver_granted", {
    waiverId: record.id,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    side: record.side,
    ticketsGranted: record.ticketsGranted,
    actorHumanId: input.actorHumanId,
  });

  const [waiver] = await attachSubjectLabels(deps, [record]);
  return { waiver: waiver! };
}

// ─────────────────────────────────────────────────────────────────────────────
// Revoke
// ─────────────────────────────────────────────────────────────────────────────

export const revokeFeeWaiverInputSchema = z
  .object({
    actorHumanId: z.string(),
    waiverId: z.uuid(),
  })
  .strict();

export const revokeFeeWaiverOutputSchema = z
  .object({ waiver: feeWaiverOutputSchema })
  .strict();

export type RevokeFeeWaiverInput = z.infer<typeof revokeFeeWaiverInputSchema>;
export type RevokeFeeWaiverOutput = z.infer<typeof revokeFeeWaiverOutputSchema>;

/**
 * Revokes an allowance. Deliberately does NOT claw back already-reserved or
 * settled tickets: those buyers were quoted a discounted price and, for settled
 * orders, already paid it. Revoking only stops FUTURE checkouts from drawing
 * on the allowance.
 */
export async function revokeFeeWaiver(
  deps: FeeWaiverDeps,
  rawInput: unknown,
): Promise<RevokeFeeWaiverOutput> {
  const logger = deps.logger?.child({ useCase: "revokeFeeWaiver" });
  const input = parseInput(revokeFeeWaiverInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const existing = await deps.repos.feeWaivers.getById(input.waiverId);
  if (!existing) {
    throw fail("NOT_FOUND", { message: "Fee waiver not found" });
  }
  if (existing.status === "REVOKED") {
    throw fail("INVALID_INPUT", { message: "Fee waiver is already revoked" });
  }

  const record = await deps.repos.feeWaivers.revoke({
    waiverId: input.waiverId,
    actorHumanId: input.actorHumanId,
  });

  logger?.info("fee_waiver_revoked", {
    waiverId: record.id,
    ticketsUsed: record.ticketsUsed,
    ticketsGranted: record.ticketsGranted,
    actorHumanId: input.actorHumanId,
  });

  const [waiver] = await attachSubjectLabels(deps, [record]);
  return { waiver: waiver! };
}
