import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  DisputeEvidenceAttentionRow,
  DisputeEvidenceStatus,
} from "@th/ports/repos/disputes";

import { describeError, parseInput } from "../../../lib/io";
import { trimTrailingSlash } from "../../../lib/url";
import {
  assembleDisputeEvidence,
  type AssembleDisputeEvidenceDeps,
} from "./assemble-dispute-evidence";
import { disputeEvidenceStatusSchema } from "./schemas";

// ─────────────────────────────────────────────────────────────────────────────
// sweepDisputeEvidenceDeadlines — the daily chase. Ops hear about a dispute
// ONCE, at open (notify-dispute-lifecycle); nothing reminds them as the
// evidence deadline closes in. This sweep reads every contestable dispute
// that is near/past its deadline, has no deadline, has no evidence package,
// or whose last submit failed, and returns one alert row per dispute for the
// job to render. It also self-heals: a dispute with NO package (webhook-time
// assembly failed, or the dispute was linked after the fact) gets
// `assembleDisputeEvidence` run best-effort, so the desk always has a draft
// to work from.
//
// Read-mostly by design. The only write is the heal, which is the same
// idempotent assembler the webhook runs; a throwing heal is reported and the
// loop continues — one broken order must not hide every other deadline.
// ─────────────────────────────────────────────────────────────────────────────

export const DISPUTE_EVIDENCE_SWEEP_DEFAULT_DUE_WITHIN_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const sweepDisputeEvidenceDeadlinesInputSchema = z
  .object({
    /** Defaults to the clock. Injectable for deterministic runs. */
    now: z.date().optional(),
    dueWithinDays: z
      .number()
      .int()
      .min(1)
      .max(14)
      .optional()
      .default(DISPUTE_EVIDENCE_SWEEP_DEFAULT_DUE_WITHIN_DAYS),
  })
  .strict();

export const disputeEvidenceAttentionBucketSchema = z.enum([
  "overdue",
  "due_soon",
  "no_due_date",
  "submit_failed",
  "unassembled",
]);

export const disputeEvidenceDeadlineAlertSchema = z
  .object({
    disputeId: z.string().min(1),
    stripeDisputeId: z.string().min(1),
    bucket: disputeEvidenceAttentionBucketSchema,
    dueBy: z.date().nullable(),
    evidenceStatus: disputeEvidenceStatusSchema.nullable(),
    amountCents: z.number().int(),
    currency: z.string().min(1),
    eventTitle: z.string().nullable(),
    owner: z.string().nullable(),
    deskUrl: z.string().min(1).optional(),
  })
  .strict();

export const sweepDisputeEvidenceDeadlinesOutputSchema = z
  .object({
    ok: z.literal(true),
    /** Rows the repo handed back (post-filter, capped). */
    scanned: z.number().int().min(0),
    /** Packages actually (re-)assembled by the heal step this run. */
    healed: z.number().int().min(0),
    /** Heal attempts that threw (reported, loop continued). */
    healFailed: z.number().int().min(0),
    alerts: z.array(disputeEvidenceDeadlineAlertSchema),
  })
  .strict();

export type SweepDisputeEvidenceDeadlinesInput = z.infer<
  typeof sweepDisputeEvidenceDeadlinesInputSchema
>;
export type SweepDisputeEvidenceDeadlinesOutput = z.infer<
  typeof sweepDisputeEvidenceDeadlinesOutputSchema
>;
export type DisputeEvidenceAttentionBucket = z.infer<
  typeof disputeEvidenceAttentionBucketSchema
>;
export type DisputeEvidenceDeadlineAlert = z.infer<
  typeof disputeEvidenceDeadlineAlertSchema
>;

export type SweepDisputeEvidenceDeadlinesDeps = {
  /** The assembler's repo slice, plus `disputes` for the sweep feed. */
  repos: AssembleDisputeEvidenceDeps["repos"] & Pick<Repos, "disputes">;
  /** The assembler's per-dispute mutex (jobs `JobContext.idempotency`). */
  idempotency: Pick<IdempotencyPort, "begin" | "release">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Public web origin; when set, every alert carries a desk deep-link. */
  publicAppUrl?: string | null;
  /**
   * Sentry hook for the heal-failure swallow branch (and the assembler's own
   * per-source degrades). Guarded — a throwing reporter never changes the
   * sweep's behaviour.
   */
  reportError?: ReporterPort | null;
};

// ── Pure classification ──────────────────────────────────────────────────────

export type ClassifyDisputeEvidenceAttentionInput = {
  now: Date;
  dueWithinDays: number;
  dueBy: Date | null;
  evidenceStatus: DisputeEvidenceStatus | null;
};

/**
 * Which alert bucket (if any) a dispute lands in. Severity order, most
 * urgent first: a package that is BOTH overdue and unassembled reads as
 * overdue — the deadline is the thing ops must act on. Returns null when the
 * dispute needs no chasing (a healthy DRAFT/APPROVED package with a deadline
 * comfortably beyond the window — e.g. a row that was only in the feed to be
 * healed).
 *
 * `due_soon` is inclusive at exactly `now + dueWithinDays`.
 */
export function classifyDisputeEvidenceAttention(
  input: ClassifyDisputeEvidenceAttentionInput,
): DisputeEvidenceAttentionBucket | null {
  const { now, dueWithinDays, dueBy, evidenceStatus } = input;
  if (dueBy !== null && dueBy.getTime() < now.getTime()) return "overdue";
  if (evidenceStatus === "SUBMIT_FAILED") return "submit_failed";
  if (evidenceStatus === null) return "unassembled";
  if (dueBy === null) return "no_due_date";
  if (dueBy.getTime() <= now.getTime() + dueWithinDays * DAY_MS) {
    return "due_soon";
  }
  return null;
}

/** Desk deep-link for one dispute, or undefined when no origin is known. */
export function buildDisputeDeskUrl(
  publicAppUrl: string | null | undefined,
  disputeId: string,
): string | undefined {
  const origin = publicAppUrl?.trim();
  if (!origin) return undefined;
  return `${trimTrailingSlash(origin)}/platform/disputes?dispute=${encodeURIComponent(disputeId)}`;
}

// ── Use case ─────────────────────────────────────────────────────────────────

export async function sweepDisputeEvidenceDeadlines(
  deps: SweepDisputeEvidenceDeadlinesDeps,
  rawInput: unknown,
): Promise<SweepDisputeEvidenceDeadlinesOutput> {
  const input = parseInput(sweepDisputeEvidenceDeadlinesInputSchema, rawInput);
  const now = input.now ?? deps.clock.now();
  const dueWithinDays = input.dueWithinDays;

  const rows = await deps.repos.disputes.listOpenNeedingEvidenceAttention({
    now,
    dueWithinDays,
  });

  let healed = 0;
  let healFailed = 0;
  const alerts: DisputeEvidenceDeadlineAlert[] = [];

  for (const row of rows) {
    let evidenceStatus = row.evidenceStatus;

    if (evidenceStatus === null) {
      const healedStatus = await healMissingPackage(deps, row);
      if (healedStatus.outcome === "assembled") {
        healed += 1;
        evidenceStatus = healedStatus.status;
      } else if (healedStatus.outcome === "already_present") {
        // Lost a race with the webhook (or a manual assemble) — take the
        // package that exists rather than alerting on a stale null.
        evidenceStatus = healedStatus.status;
      } else if (healedStatus.outcome === "failed") {
        healFailed += 1;
      }
      // "unlinked" leaves evidenceStatus null → classified as unassembled.
    }

    const bucket = classifyDisputeEvidenceAttention({
      now,
      dueWithinDays,
      dueBy: row.evidenceDueBy,
      evidenceStatus,
    });
    if (!bucket) continue;

    alerts.push({
      disputeId: row.id,
      stripeDisputeId: row.stripeDisputeId,
      bucket,
      dueBy: row.evidenceDueBy,
      evidenceStatus,
      amountCents: row.amountCents,
      currency: row.currency,
      eventTitle: row.eventTitle,
      owner: row.ownerOrgName ?? row.ownerHumanName ?? null,
      ...(deps.publicAppUrl
        ? { deskUrl: buildDisputeDeskUrl(deps.publicAppUrl, row.id) }
        : {}),
    });
  }

  deps.logger?.info("dispute.evidence.sweep.completed", {
    scanned: rows.length,
    healed,
    healFailed,
    alerts: alerts.length,
    dueWithinDays,
  });

  return sweepDisputeEvidenceDeadlinesOutputSchema.parse({
    ok: true,
    scanned: rows.length,
    healed,
    healFailed,
    alerts,
  });
}

type HealOutcome =
  | { outcome: "assembled"; status: DisputeEvidenceStatus }
  | { outcome: "already_present"; status: DisputeEvidenceStatus }
  | { outcome: "unlinked" }
  | { outcome: "failed" };

/**
 * Best-effort re-run of the webhook-time assembly for a dispute with no
 * package. A throw is logged + reported and turned into `failed` so the
 * sweep keeps going; the dispute still surfaces as `unassembled` in the
 * alert, which is the signal a human needs to go look at it.
 */
async function healMissingPackage(
  deps: SweepDisputeEvidenceDeadlinesDeps,
  row: DisputeEvidenceAttentionRow,
): Promise<HealOutcome> {
  try {
    const result = await assembleDisputeEvidence(
      {
        repos: deps.repos,
        idempotency: deps.idempotency,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      { disputeId: row.id },
    );
    if (result.evidence) {
      return result.skipped === null
        ? { outcome: "assembled", status: result.evidence.status }
        : { outcome: "already_present", status: result.evidence.status };
    }
    return { outcome: "unlinked" };
  } catch (err) {
    deps.logger?.error("dispute.evidence.sweep.heal_failed", {
      disputeId: row.id,
      stripeDisputeId: row.stripeDisputeId,
      orderId: row.orderId,
      error: describeError(err),
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "sweepDisputeEvidenceDeadlines", step: "heal" },
        extra: {
          disputeId: row.id,
          stripeDisputeId: row.stripeDisputeId,
          orderId: row.orderId,
        },
      });
    } catch {
      // Reporter failures never change behaviour.
    }
    return { outcome: "failed" };
  }
}
