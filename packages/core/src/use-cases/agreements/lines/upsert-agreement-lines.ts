import { randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { TxRepos } from "@th/ports/repos";
import { payoutTermsLineRoundingSchema } from "@th/schema";

import {
  agreementLineInputSchema,
  describeError,
  ensurePayeesActive,
  fetchExistingAgreement,
  normalizeLines,
  parseInput,
  toRepoLineInput,
  validateLines,
  type UpsertAgreementDeps,
} from "../_shared/upsert-agreement-shared";
import {
  assertDealScopeUnchanged,
  assertDealWritable,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
} from "../../deals/_shared/deal-freeze";
import {
  requireOrgMembership,
  ORG_EDIT_OR_FINANCE_ROLES,
} from "../../../lib/rbac";
import { asKnownError } from "../../../lib/errors";
import { fail } from "@th/errors";

const capPercentSchema = z
  .union([z.null(), z.coerce.number().int().min(0).max(100)])
  .optional()
  .transform((value) => (value === undefined ? null : value));

export const upsertPayoutTermsLineInputSchema = z.object({
  actorHumanId: z.uuid(),
  agreementId: z.uuid(),
  clientKey: z.string().min(8),
  /**
   * freeze-the-deal FR-004: true = knowingly change a frozen event's deal
   * (every payee is told). Without it, terms of a frozen event are refused
   * (DEAL_FROZEN).
   */
  frozenChange: z.boolean().optional(),
  lineId: agreementLineInputSchema.shape.lineId,
  payeeId: agreementLineInputSchema.shape.payeeId,
  percent: agreementLineInputSchema.shape.percent,
  floorCents: agreementLineInputSchema.shape.floorCents,
  capPercent: capPercentSchema,
  priority: z.coerce.number().int().default(0),
  rounding: agreementLineInputSchema.shape.rounding,
});

const normalizedLineSchema = z.object({
  percent: z.number().int().min(0).max(100),
  floorCents: z.number().int().min(0),
  capPercent: z.number().int().min(0).max(100).nullable(),
  priority: z.number().int(),
  rounding: payoutTermsLineRoundingSchema,
});

export const upsertAgreementLineOutputSchema = z.object({
  lineId: z.uuid(),
  agreementId: z.uuid(),
  normalized: normalizedLineSchema,
});

export type UpsertPayoutTermsLineInput = z.infer<
  typeof upsertPayoutTermsLineInputSchema
>;
export type UpsertAgreementLineOutput = z.infer<
  typeof upsertAgreementLineOutputSchema
>;

type NormalizedLine = ReturnType<typeof normalizeLines>[number];

interface StoredPayoutTermsLineRecord {
  payloadHash: string;
  response: UpsertAgreementLineOutput;
}

export async function upsertAgreementLine(
  deps: UpsertAgreementDeps,
  rawInput: unknown,
): Promise<UpsertAgreementLineOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "upsertAgreementLine" });

  const execute = async () => {
    const input = parseInput(upsertPayoutTermsLineInputSchema, rawInput);

    const lineDto = agreementLineInputSchema.parse({
      lineId: input.lineId,
      payeeId: input.payeeId,
      percent: input.percent,
      floorCents: input.floorCents,
      capPercent: input.capPercent ?? undefined,
      priority: input.priority,
      rounding: input.rounding,
    });

    const normalizedInputLine = normalizeLines([lineDto])[0]!;

    const idempotencyKey = `agreementLine:${input.agreementId}:${normalizedInputLine.payeeId}:${input.clientKey}`;
    const payloadHash = buildPayloadHash(input, normalizedInputLine);

    const replay =
      await deps.idempotency.get<StoredPayoutTermsLineRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const acquired = await deps.idempotency.begin(idempotencyKey, 120);
    if (!acquired) {
      const afterWait =
        await deps.idempotency.get<StoredPayoutTermsLineRecord>(idempotencyKey);
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
        // freeze-the-deal: the row of the event these terms belong to (if
        // any) first, before the terms lock (the order in deal-freeze.ts).
        const preOwner = await tx.events.findByPayoutTermsId(input.agreementId);
        const lockedScope = preOwner
          ? ({ kind: "EVENT", eventId: preOwner.id } as const)
          : null;
        await lockDealEvent(tx, lockedScope);
        // ── P4b (deal terms) ── then the terms row lock (review B1, round 2):
        // every writer of PayoutTermsLine takes it before reading the lines it
        // rewrites, so a legacy line edit and a deal write can never interleave
        // — the later one reads what the earlier one committed.
        // (A missing row falls through to the not-found refusal below.)
        await tx.deals.lockTerms(input.agreementId);
        const agreement = await fetchExistingAgreement(tx, input.agreementId);

        await ensureActorCanModifyAgreement(tx, agreement, input.actorHumanId);

        // freeze-the-deal FR-004: these terms may be an event's (that is
        // the only owner this path admits). Under the event and terms locks
        // above; the owner re-read under them must be the one locked.
        const owningEvent = await tx.events.findByPayoutTermsId(agreement.id);
        const scope = owningEvent
          ? ({ kind: "EVENT", eventId: owningEvent.id } as const)
          : null;
        assertDealScopeUnchanged(lockedScope, scope);
        const fence = await assertDealWritable(tx, {
          scope,
          frozenChange: input.frozenChange,
        });

        const existingLines = await tx.payoutTerms.listLines(agreement.id);
        const normalizedExisting = existingLines.map(toNormalizedLine);

        const { nextLines, previousLine, targetLine } = applyLineUpdate(
          normalizedExisting,
          normalizedInputLine,
        );

        validateLines(nextLines, existingLines);
        await ensurePayeesActive(tx.payees, [targetLine], scopedLogger);

        const targetLineId = targetLine.id ?? randomUUID();

        const linesForPersistence = nextLines.map((line) =>
          line === targetLine
            ? {
                ...line,
                id: targetLineId,
              }
            : line,
        );

        // Carry confirmation lifecycle state through the delete-and-recreate
        // rewrite (preserve on unchanged economics, reset to PENDING on
        // change) — see `toRepoLineInput` in the shared engine.
        const priorByPayeeId = new Map(
          existingLines.map((record) => [record.payeeId, record]),
        );
        await tx.payoutTerms.replaceLines(
          agreement.id,
          linesForPersistence.map((line) =>
            toRepoLineInput(line, priorByPayeeId.get(line.payeeId)),
          ),
        );

        const persistedLines = await tx.payoutTerms.listLines(agreement.id);
        const persistedTarget = findPersistedLine(persistedLines, {
          ...targetLine,
          id: targetLineId,
        });
        if (!persistedTarget) {
          throw fail("AGREEMENT_LINE_PERSIST_FAILED");
        }

        const finalLine = toNormalizedLine(persistedTarget);
        const changes = diffLines(previousLine, finalLine);

        const now = deps.clock.now();

        await tx.audit.log({
          entity: "agreement_line",
          entityId: finalLine.id ?? null,
          action: previousLine ? "updated" : "created",
          data: {
            agreementId: agreement.id,
            payeeId: finalLine.payeeId,
            before: previousLine ? snapshotLine(previousLine) : null,
            after: snapshotLine(finalLine),
            diff: changes,
          },
          at: now,
        });

        const change = await recordDealChange(tx, fence, {
          actorHumanId: input.actorHumanId,
          at: now,
        });

        return {
          change,
          out: upsertAgreementLineOutputSchema.parse({
            lineId: finalLine.id!,
            agreementId: agreement.id,
            normalized: snapshotLine(finalLine),
          }),
        };
      });

      await deps.idempotency.commit<StoredPayoutTermsLineRecord>(
        idempotencyKey,
        {
          payloadHash,
          response: result.out,
        },
      );

      // freeze-the-deal FR-006: after the commit. Best effort: never throws.
      if (result.change) await notifyDealChange(deps, result.change);

      return result.out;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("upsert_agreement_lines", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("upsertAgreementLine", execute);
  }

  return execute();
}

function buildPayloadHash(
  input: UpsertPayoutTermsLineInput,
  line: NormalizedLine,
): string {
  const payload = {
    actorHumanId: input.actorHumanId,
    agreementId: input.agreementId,
    line: {
      id: line.id ?? null,
      payeeId: line.payeeId,
      percent: line.percent,
      floorCents: line.floorCents,
      capPercent: line.capPercent,
      priority: line.priority,
      rounding: line.rounding,
    },
  };
  return JSON.stringify(payload);
}

async function ensureActorCanModifyAgreement(
  tx: TxRepos,
  agreement: PayoutTermsRecord,
  actorHumanId: string,
) {
  // Discover owner by checking which entity references this PayoutTerms via FK.
  const event = await tx.events.findByPayoutTermsId(agreement.id);
  if (event) {
    return ensureEventAccess(tx, event.id, actorHumanId);
  }

  // No owning entity found — deny access as a safe default.
  // Once org/human PayoutTerms gain proper FK paths (via Agreement model),
  // add reverse-lookup branches here.
  throw fail("HUMAN_NOT_FOUND", { meta: { role: "agreement_owner" }, category: "FORBIDDEN" });
}

async function ensureEventAccess(
  tx: TxRepos,
  eventId: string,
  actorHumanId: string,
): Promise<void> {
  const event = await tx.events.getById(eventId);

  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_OR_FINANCE_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else if (event.humanId !== actorHumanId) {
    // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28) — see
    // `ensurePayoutRoutingActor` in `lib/event-edit-rights.ts`.
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
  }

  if (event.status === "ARCHIVED") {
    throw fail("EVENT_ARCHIVED");
  }
}

async function ensureOrgAccess(
  tx: TxRepos,
  orgId: string,
  actorHumanId: string,
): Promise<void> {
  const org = await tx.organizations.getById(orgId);

  if (!org) {
    throw fail("ORGANIZATION_NOT_FOUND");
  }

  if (org.status !== "ACTIVE") {
    throw fail("ORGANIZATION_INACTIVE");
  }

  await requireOrgMembership({
    repos: tx,
    orgId,
    actorHumanId,
    roles: ORG_EDIT_OR_FINANCE_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
}

function applyLineUpdate(
  existingLines: NormalizedLine[],
  inputLine: NormalizedLine,
): {
  nextLines: NormalizedLine[];
  previousLine: NormalizedLine | null;
  targetLine: NormalizedLine;
} {
  if (inputLine.id) {
    const index = existingLines.findIndex((line) => line.id === inputLine.id);
    if (index === -1) {
      throw fail("AGREEMENT_LINE_NOT_FOUND");
    }

    const prior = existingLines[index]!;
    if (prior.payeeId !== inputLine.payeeId) {
      throw fail("PAYEE_CHANGE_NOT_ALLOWED");
    }

    const updated: NormalizedLine = {
      ...prior,
      percent: inputLine.percent,
      floorCents: inputLine.floorCents,
      capPercent: inputLine.capPercent,
      priority: inputLine.priority,
      rounding: inputLine.rounding,
    };

    const next = existingLines.map((line, idx) =>
      idx === index ? updated : line,
    );
    return { nextLines: next, previousLine: prior, targetLine: updated };
  }

  if (existingLines.some((line) => line.payeeId === inputLine.payeeId)) {
    throw fail("PAYEE_ALREADY_ASSIGNED");
  }

  const created: NormalizedLine = {
    id: undefined,
    payeeId: inputLine.payeeId,
    percent: inputLine.percent,
    floorCents: inputLine.floorCents,
    capPercent: inputLine.capPercent,
    priority: inputLine.priority,
    rounding: inputLine.rounding,
  };

  return {
    nextLines: [...existingLines, created],
    previousLine: null,
    targetLine: created,
  };
}

function toNormalizedLine(record: PayoutTermsLineRecord): NormalizedLine {
  return {
    id: record.id,
    payeeId: record.payeeId,
    percent: record.percent,
    floorCents: record.floorCents,
    capPercent: record.capPercent,
    priority: record.priority,
    rounding: record.rounding,
  };
}

function findPersistedLine(
  records: PayoutTermsLineRecord[],
  line: NormalizedLine,
): PayoutTermsLineRecord | undefined {
  if (line.id) {
    return records.find((candidate) => candidate.id === line.id);
  }
  return records.find((candidate) => candidate.payeeId === line.payeeId);
}

function snapshotLine(line: NormalizedLine) {
  return {
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent,
    priority: line.priority,
    rounding: line.rounding,
  };
}

function diffLines(before: NormalizedLine | null, after: NormalizedLine) {
  if (!before) {
    return {
      percent: { before: null, after: after.percent },
      floorCents: { before: null, after: after.floorCents },
      capPercent: { before: null, after: after.capPercent },
      priority: { before: null, after: after.priority },
      rounding: { before: null, after: after.rounding },
    } as const;
  }

  const entries: Record<string, { before: unknown; after: unknown }> = {};
  const fields: Array<keyof ReturnType<typeof snapshotLine>> = [
    "percent",
    "floorCents",
    "capPercent",
    "priority",
    "rounding",
  ];

  for (const field of fields) {
    const previousValue = before[field];
    const nextValue = after[field];
    if (previousValue !== nextValue) {
      entries[field] = { before: previousValue, after: nextValue };
    }
  }

  return Object.keys(entries).length > 0 ? entries : null;
}
