import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { ensurePayoutRoutingActor } from "../../lib/event-edit-rights";

const SPLIT_KIND = ["PRIMARY", "RESALE"] as const;

export const getEventSplitsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    kind: z.enum(SPLIT_KIND),
  })
  .strict();

const lineSchema = z.object({
  id: z.string().uuid(),
  payeeId: z.string().uuid(),
  /**
   * The org or human the payee stands for: what `updateEventSplits` takes as
   * `payeeRef.id`. NOT `payeeId` (the Payee row). An editor that sent the
   * row id back had it resolved as a subject id, found nothing, and minted a
   * new Payee for a subject that doesn't exist, moving the line's money to it
   * on every re-save. Null only when the payee row is missing.
   */
  payeeSubjectId: z.string().uuid().nullable(),
  payeeKind: z.enum(["org", "human"]),
  payeeDisplayName: z.string().nullable(),
  payeeStatus: z.enum(["missing", "pending_setup", "active"]),
  ticketTypeId: z.string().uuid().nullable(),
  ticketTypeName: z.string().nullable(),
  percentBps: z.number().int(),
  floorCents: z.number().int(),
  capPercent: z.number().int().nullable(),
  priority: z.number().int(),
  source: z.enum(["owner", "lineup-picker", "manual"]),
  requiresConfirmation: z.boolean(),
  confirmationStatus: z
    .enum(["PENDING", "CONFIRMED", "COUNTERED", "DECLINED"])
    .nullable(),
  confirmedAt: z.date().nullable(),
  counterPercentBps: z.number().int().nullable(),
  counterNote: z.string().nullable(),
});

const lineupSuggestionSchema = z.object({
  eventHumanId: z.string().uuid(),
  humanId: z.string().uuid(),
  displayName: z.string().nullable(),
  role: z.string(),
  payeeStatus: z.enum(["missing", "pending_setup", "active"]),
  alreadyOnTerms: z.boolean(),
});

export const getEventSplitsOutputSchema = z
  .object({
    terms: z
      .object({
        id: z.string().uuid().nullable(),
        kind: z.enum(SPLIT_KIND),
        totalAllocatedBps: z.number().int(),
      })
      .strict(),
    lines: z.array(lineSchema),
    lineupSuggestions: z.array(lineupSuggestionSchema),
    /**
     * Platform fee in basis points. Informational only — splits always
     * divide the seller's post-fee net regardless.
     */
    platformFeeBps: z.number().int(),
    publishGateBlockers: z.array(z.string()),
  })
  .strict();

export type GetEventSplitsInput = z.infer<typeof getEventSplitsInputSchema>;
export type GetEventSplitsOutput = z.infer<typeof getEventSplitsOutputSchema>;

export type GetEventSplitsDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "eventHumans"
    | "payoutTerms"
    | "payees"
    | "humans"
    | "organizations"
    | "feePolicies"
  >;
  authz: Pick<AuthZPort, "canEditEvent">;
  clock: ClockPort;
  logger?: LoggerPort;
};

const PLATFORM_FEE_FALLBACK_BPS = 500; // 5% — used when no FeePolicy is resolvable.

export async function getEventSplits(
  deps: GetEventSplitsDeps,
  rawInput: unknown,
): Promise<GetEventSplitsOutput> {
  const input = parseInput(getEventSplitsInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const canEdit = await deps.authz.canEditEvent({
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
  });
  if (!canEdit.allowed) {
    throw fail("INSUFFICIENT_ROLE");
  }
  // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). `canEditEvent`
  // admits a human owner's edit-role delegates; splits decide who gets paid,
  // so on a human-owned event only the owner passes. Org arm unchanged.
  ensurePayoutRoutingActor(event, input.actorHumanId, "INSUFFICIENT_ROLE");

  const termsId =
    input.kind === "PRIMARY" ? event.payoutTermsId : event.resalePayoutTermsId;

  // No terms yet → return an empty editor view. The UI shows "no splits
  // composed yet"; the publish gate blockers below capture the missing
  // terms situation when applicable.
  const terms = termsId ? await deps.repos.payoutTerms.getById(termsId) : null;
  const rawLines = termsId
    ? await deps.repos.payoutTerms.listLines(termsId)
    : [];

  // Hydrate payees (batch).
  const payeeIds = Array.from(new Set(rawLines.map((l) => l.payeeId)));
  const payees =
    payeeIds.length > 0 ? await deps.repos.payees.getByIds(payeeIds) : [];
  const payeeById = new Map(payees.map((p) => [p.id, p]));

  // Hydrate display names — orgs and humans separately.
  const orgIds = Array.from(
    new Set(
      payees
        .filter((p) => p.subjectType === "ORGANIZATION")
        .map((p) => p.subjectId),
    ),
  );
  const humanIds = Array.from(
    new Set(
      payees.filter((p) => p.subjectType === "HUMAN").map((p) => p.subjectId),
    ),
  );

  const [orgs, humans, lineup] = await Promise.all([
    orgIds.length
      ? deps.repos.organizations.getByIds(orgIds)
      : Promise.resolve([]),
    humanIds.length
      ? deps.repos.humans.getByIds(humanIds)
      : Promise.resolve([]),
    deps.repos.eventHumans.listByEvent(input.eventId),
  ]);
  const orgNameById = new Map(orgs.map((o) => [o.id, o.name]));
  const humanNameById = new Map(humans.map((h) => [h.id, h.name]));

  // Owner identity for source labeling.
  const ownerSubjectId = event.orgId ?? event.humanId ?? null;
  const ownerSubjectType: "ORGANIZATION" | "HUMAN" | null = event.orgId
    ? "ORGANIZATION"
    : event.humanId
      ? "HUMAN"
      : null;

  // Lineup humanId set for "lineup-picker" derivation.
  const lineupHumanIds = new Set(
    lineup.map((row) => row.humanId).filter((id): id is string => Boolean(id)),
  );

  // Payee status helper.
  const payeeStatusFor = (
    payeeId: string,
  ): "missing" | "pending_setup" | "active" => {
    const payee = payeeById.get(payeeId);
    if (!payee) return "missing";
    if (payee.payoutsEnabled) return "active";
    return "pending_setup";
  };

  // Source derivation per line.
  const sourceFor = (payeeId: string): "owner" | "lineup-picker" | "manual" => {
    const payee = payeeById.get(payeeId);
    if (!payee) return "manual";
    if (
      ownerSubjectType &&
      payee.subjectType === ownerSubjectType &&
      payee.subjectId === ownerSubjectId
    ) {
      return "owner";
    }
    if (payee.subjectType === "HUMAN" && lineupHumanIds.has(payee.subjectId)) {
      return "lineup-picker";
    }
    return "manual";
  };

  const linesOut = rawLines.map((line) => {
    const payee = payeeById.get(line.payeeId);
    const payeeKind: "org" | "human" =
      payee?.subjectType === "ORGANIZATION" ? "org" : "human";
    const displayName = payee
      ? payee.subjectType === "ORGANIZATION"
        ? (orgNameById.get(payee.subjectId) ?? null)
        : (humanNameById.get(payee.subjectId) ?? null)
      : null;
    return {
      id: line.id,
      payeeId: line.payeeId,
      payeeSubjectId: payee?.subjectId ?? null,
      payeeKind,
      payeeDisplayName: displayName,
      payeeStatus: payeeStatusFor(line.payeeId),
      ticketTypeId: line.ticketTypeId,
      ticketTypeName: null as string | null, // hydrated by callers needing it; keep this read minimal
      // PayoutTermsLine.percent is stored as whole percent (0–100). Surface
      // bps in the API so the UI doesn't have to think in percent vs bps.
      percentBps: line.percent * 100,
      floorCents: line.floorCents,
      capPercent: line.capPercent,
      priority: line.priority,
      source: sourceFor(line.payeeId),
      requiresConfirmation: line.requiresConfirmation,
      confirmationStatus: line.confirmationStatus,
      confirmedAt: line.confirmedAt,
      counterPercentBps: line.counterPercentBps,
      counterNote: line.counterNote,
    };
  });

  // Total allocated (in basis points). PayoutTermsLine.percent is stored as
  // whole-percent (0–100) per the existing convention; we surface bps in the
  // API for UI precision so 33% renders as 3300 bps. DECLINED lines are
  // treated as zero.
  const totalAllocatedBps = linesOut
    .filter((l) => l.confirmationStatus !== "DECLINED")
    .reduce((sum, l) => sum + l.percentBps, 0);

  // Resolve platform fee. Best-effort: any failure falls back to the
  // platform-wide default. Informational only — settlement always
  // distributes against the seller's post-fee net.
  let platformFeeBps = PLATFORM_FEE_FALLBACK_BPS;
  try {
    const feePolicy = await deps.repos.feePolicies.resolveEffective({
      scopeType: event.orgId ? "ORG" : "GLOBAL",
      scopeId: event.orgId ?? null,
      at: deps.clock.now(),
    });
    if (feePolicy) {
      platformFeeBps = Math.round(feePolicy.buyerFeePct * 10000);
    }
  } catch (err) {
    deps.logger?.warn("get_event_splits.fee_policy_lookup_failed", {
      eventId: input.eventId,
      error: String(err),
    });
  }

  // Compute lineup suggestions: humans on the lineup whose Payee status is
  // resolvable (registered humans only). Rendered as quick-pick chips in
  // the add-line picker. Free-text rows are excluded.
  const lineupHumanIdsArr = lineup
    .map((r) => r.humanId)
    .filter((id): id is string => Boolean(id));
  const lineupPayees =
    lineupHumanIdsArr.length > 0
      ? await Promise.all(
          lineupHumanIdsArr.map((id) =>
            deps.repos.payees.getBySubject({ type: "HUMAN", id }),
          ),
        )
      : [];
  const payeeIdByLineupHumanId = new Map<string, string>();
  lineupHumanIdsArr.forEach((humanId, idx) => {
    const p = lineupPayees[idx];
    if (p) payeeIdByLineupHumanId.set(humanId, p.id);
  });
  const linePayeeIds = new Set(rawLines.map((l) => l.payeeId));
  const suggestionsOut = lineup
    .filter((row) => row.humanId)
    .map((row) => {
      const humanId = row.humanId!;
      const payeeId = payeeIdByLineupHumanId.get(humanId) ?? null;
      const payeeStatus: "missing" | "pending_setup" | "active" = payeeId
        ? payeeStatusFor(payeeId)
        : "missing";
      return {
        eventHumanId: row.id,
        humanId,
        displayName: row.humanDisplayName ?? row.externalName,
        role: row.customRoleLabel ?? row.role,
        payeeStatus,
        alreadyOnTerms: payeeId ? linePayeeIds.has(payeeId) : false,
      };
    });

  // Publish gate blockers (the editor surfaces these in a sidebar; the
  // authoritative gate lives in `assertEventPublishable`, but the editor
  // wants the same answers without a separate round-trip).
  const blockers: string[] = [];
  if (input.kind === "PRIMARY" && terms && linesOut.length > 0) {
    // Splits always divide 100% of the seller's post-fee net. Platform +
    // processor fees come off the top in the settlement pipeline before
    // any payee gets paid.
    // Storage is whole-percent so the UI can drift by up to 100bps even
    // when "perfectly" balanced. Match the publish gate's tolerance.
    const drift = Math.abs(totalAllocatedBps - 10000);
    if (drift > 100) {
      blockers.push("splits_total_invalid");
    }
  }
  for (const line of linesOut) {
    if (line.payeeStatus !== "active") {
      blockers.push("payee_not_active");
      break;
    }
  }

  deps.logger?.info("events.get_splits", {
    eventId: input.eventId,
    kind: input.kind,
    actorHumanId: input.actorHumanId,
    lineCount: linesOut.length,
    blockerCount: blockers.length,
  });

  return getEventSplitsOutputSchema.parse({
    terms: {
      id: terms?.id ?? null,
      kind: input.kind,
      totalAllocatedBps,
    },
    lines: linesOut,
    lineupSuggestions: suggestionsOut,
    platformFeeBps,
    publishGateBlockers: blockers,
  });
}
