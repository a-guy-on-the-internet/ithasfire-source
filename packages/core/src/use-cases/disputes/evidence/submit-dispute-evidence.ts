import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PaymentProcessorPort,
  ProcessorDisputeSnapshot,
  ProcessorDisputeStatus,
} from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { DisputeRecord } from "@th/ports/repos/disputes";
import type { DisputeEvidenceRecord } from "@th/ports/repos/dispute-evidence";
import {
  checkDisputeEvidenceLimits,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";
import { AppError, fail } from "@th/errors";

import { describeError, parseInput } from "../../../lib/io";
import { withDisputeEvidenceMutex } from "./_shared/evidence-mutex";
import {
  disputeEvidenceRecordSchema,
  processorProvenanceSources,
} from "./schemas";
import { requireDisputeDeskStaff, type DisputeDeskAuthzDeps } from "./staff";

// ─────────────────────────────────────────────────────────────────────────────
// submitDisputeEvidence — sends an APPROVED package to the processor with
// `submit: true`. Irreversible at the bank, so the guards run in this order:
//
//   1. actor is ADMIN (in the use case, not only the transport);
//   2. the per-DISPUTE mutex (`_shared/evidence-mutex.ts`) is claimed BEFORE
//      any read — every other package mutation (edit / approve / force
//      re-assemble) takes the same lock, so nothing can change the package
//      between the read below and the terminal write;
//   3. the package is re-read INSIDE the lock and must be APPROVED + non-empty;
//   4. a LIVE processor read: the dispute must be `needs_response` /
//      `warning_needs_response` and not past due — Stripe's own error for
//      "not accepting evidence" comes through the adapter raw, so this read
//      is the primary defence, not a nicety. If the row is APPROVED but the
//      processor already shows a submission (a crash between Stripe's accept
//      and our commit on an earlier attempt), the row is RECONCILED to
//      SUBMITTED from the live snapshot instead of stranded forever;
//   5. the size caps re-checked on the MERGED hash (what Stripe already
//      holds + our package), because the 150k combined cap applies to the
//      merged result, not to our delta;
//   6. the terminal write is a compare-and-set on (APPROVED, assembledVersion)
//      — belt and braces under the mutex: if it ever misses, the processor
//      call has happened but the local row is NOT stamped over foreign
//      fields; the miss is reported as a state error for ops.
//
// Processor idempotency key: `dispute-evidence:<disputeId>:<assembledVersion>:update`.
// `assembledVersion` is the immutable attempt id — a re-assemble bumps it
// and yields a fresh key; a retry of the same package replays. A caller may
// override it (the transport does not).
//
// On processor failure the package goes SUBMIT_FAILED with a sanitised
// message (no PII), the failure is reported, and a typed error is rethrown.
// TODO(notify): the risk-owner notifier lives in
// `../notify-dispute-lifecycle.ts` and is under review; wire an
// "evidence submitted" notice there once it lands — deliberately not here.
// ─────────────────────────────────────────────────────────────────────────────

const ACCEPTING_STATUSES: ReadonlySet<ProcessorDisputeStatus> = new Set([
  "needs_response",
  "warning_needs_response",
]);

export function buildDisputeEvidenceSubmitKey(
  disputeId: string,
  assembledVersion: number,
): string {
  return `dispute-evidence:${disputeId}:${assembledVersion}:update`;
}

export const submitDisputeEvidenceInputSchema = z
  .object({
    disputeId: z.string().min(1),
    actorHumanId: z.string().min(1),
    /** Processor idempotency key override; defaults to the version-keyed one. */
    idempotencyKey: z.string().min(8).max(255).optional(),
  })
  .strict();

export const submitDisputeEvidenceOutputSchema = z
  .object({
    ok: z.literal(true),
    evidence: disputeEvidenceRecordSchema,
    processorStatus: z.string(),
    processorSubmissionCount: z.number().int().nonnegative(),
    idempotencyKey: z.string(),
    /**
     * True when no processor call was made on THIS run: the row was APPROVED
     * but the live dispute already carried our submission (an earlier
     * attempt crashed after Stripe accepted), so the row was brought into
     * line with the processor instead.
     */
    reconciledFromProcessor: z.boolean(),
  })
  .strict();

export type SubmitDisputeEvidenceInput = z.infer<
  typeof submitDisputeEvidenceInputSchema
>;
export type SubmitDisputeEvidenceOutput = z.infer<
  typeof submitDisputeEvidenceOutputSchema
>;

export type SubmitDisputeEvidenceDeps = DisputeDeskAuthzDeps & {
  repos: Pick<Repos, "tx" | "disputes" | "disputeEvidence" | "audit">;
  payments: Pick<
    PaymentProcessorPort,
    "retrieveDispute" | "updateDisputeEvidence"
  >;
  idempotency: Pick<IdempotencyPort, "begin" | "release">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Sentry hook for the processor failure branch (state is persisted, error rethrown). */
  reportError?: ReporterPort | null;
};

export async function submitDisputeEvidence(
  deps: SubmitDisputeEvidenceDeps,
  rawInput: unknown,
): Promise<SubmitDisputeEvidenceOutput> {
  const input = parseInput(submitDisputeEvidenceInputSchema, rawInput);
  await requireDisputeDeskStaff(deps, input.actorHumanId, "write");

  // Lock BEFORE any read — see the module doc for the two races this closes.
  return withDisputeEvidenceMutex(deps, input.disputeId, async () => {
    const dispute = await deps.repos.disputes.getById(input.disputeId);
    if (!dispute) {
      throw fail("DISPUTE_NOT_FOUND", { meta: { disputeId: input.disputeId } });
    }
    const evidence = await deps.repos.disputeEvidence.getByDisputeId(dispute.id);
    if (!evidence) {
      throw fail("DISPUTE_EVIDENCE_NOT_FOUND", {
        meta: { disputeId: dispute.id },
      });
    }
    if (evidence.status !== "APPROVED") {
      throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
        message: "dispute evidence must be approved before it can be submitted",
        meta: { disputeId: dispute.id, status: evidence.status },
      });
    }
    const fields: DisputeEvidenceFields = evidence.fields;
    if (Object.keys(fields).length === 0) {
      throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
        message: "dispute evidence package is empty",
        meta: { disputeId: dispute.id },
      });
    }

    const processorKey =
      input.idempotencyKey ??
      buildDisputeEvidenceSubmitKey(dispute.id, evidence.assembledVersion);

    // Live read — never trust the mirror columns for an irreversible call.
    const live = await deps.payments.retrieveDispute({
      processorDisputeId: dispute.stripeDisputeId,
    });
    if (!ACCEPTING_STATUSES.has(live.status) || live.evidenceDetails.pastDue) {
      // An earlier attempt may have crashed AFTER Stripe accepted and BEFORE
      // our commit: the row is still APPROVED but the processor already
      // holds a submission. Bring the row into line instead of erroring
      // forever.
      if (
        live.evidenceDetails.hasEvidence &&
        live.evidenceDetails.submissionCount > 0
      ) {
        const reconciled = await stampSubmitted(deps, {
          dispute,
          evidence,
          actorHumanId: input.actorHumanId,
          processorKey,
          snapshot: live,
          reconciledFromProcessor: true,
        });
        deps.logger?.warn("dispute.evidence.reconciled_from_processor", {
          disputeId: dispute.id,
          stripeDisputeId: dispute.stripeDisputeId,
          processorStatus: live.status,
          processorSubmissionCount: live.evidenceDetails.submissionCount,
        });
        return submitDisputeEvidenceOutputSchema.parse({
          ok: true,
          evidence: reconciled,
          processorStatus: live.status,
          processorSubmissionCount: live.evidenceDetails.submissionCount,
          idempotencyKey: processorKey,
          reconciledFromProcessor: true,
        });
      }
      throw fail("DISPUTE_NOT_ACCEPTING_EVIDENCE", {
        message: live.evidenceDetails.pastDue
          ? "the evidence deadline has passed"
          : `dispute is ${live.status}; evidence can only be submitted while a response is needed`,
        meta: {
          disputeId: dispute.id,
          processorStatus: live.status,
          pastDue: live.evidenceDetails.pastDue,
          dueBy: live.evidenceDetails.dueBy,
        },
      });
    }

    // Stripe's caps apply to the MERGED evidence hash.
    const merged: DisputeEvidenceFields = { ...live.evidence, ...fields };
    const limits = checkDisputeEvidenceLimits(merged);
    if (!limits.ok) {
      throw fail("DISPUTE_EVIDENCE_LIMIT_EXCEEDED", {
        message:
          "dispute evidence exceeds the processor's size limits once merged with already-staged evidence",
        meta: {
          disputeId: dispute.id,
          combinedChars: limits.combinedChars,
          violations: limits.violations,
        },
      });
    }

    let snapshot: ProcessorDisputeSnapshot;
    try {
      snapshot = await deps.payments.updateDisputeEvidence({
        processorDisputeId: dispute.stripeDisputeId,
        evidence: fields,
        submit: true,
        idempotencyKey: processorKey,
      });
    } catch (err) {
      await recordSubmitFailure(deps, evidence, input.actorHumanId, err);
      throw toSubmitError(err, dispute.id);
    }

    const stored = await stampSubmitted(deps, {
      dispute,
      evidence,
      actorHumanId: input.actorHumanId,
      processorKey,
      snapshot,
      reconciledFromProcessor: false,
    });

    deps.logger?.info("dispute.evidence.submitted", {
      disputeId: dispute.id,
      stripeDisputeId: dispute.stripeDisputeId,
      actorHumanId: input.actorHumanId,
      processorStatus: snapshot.status,
      processorSubmissionCount: snapshot.evidenceDetails.submissionCount,
    });

    return submitDisputeEvidenceOutputSchema.parse({
      ok: true,
      evidence: stored,
      processorStatus: snapshot.status,
      processorSubmissionCount: snapshot.evidenceDetails.submissionCount,
      idempotencyKey: processorKey,
      reconciledFromProcessor: false,
    });
  });
}

/**
 * The terminal write: package → SUBMITTED (compare-and-set on the exact
 * APPROVED row + version that was read under the lock), Dispute mirror
 * columns from the processor snapshot, one audit row. One transaction.
 */
async function stampSubmitted(
  deps: SubmitDisputeEvidenceDeps,
  args: {
    dispute: DisputeRecord;
    evidence: DisputeEvidenceRecord;
    actorHumanId: string;
    processorKey: string;
    snapshot: ProcessorDisputeSnapshot;
    reconciledFromProcessor: boolean;
  },
): Promise<DisputeEvidenceRecord> {
  const { dispute, evidence, snapshot } = args;
  return deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const updated = await tx.disputeEvidence.update({
      disputeId: dispute.id,
      expect: { status: "APPROVED", assembledVersion: evidence.assembledVersion },
      status: "SUBMITTED",
      // Reconciled: the record of what the bank saw is what the PROCESSOR
      // reports it holds, not our local draft; nobody at the desk submitted
      // it on this run; provenance is "from the processor".
      ...(args.reconciledFromProcessor
        ? {
            fields: snapshot.evidence,
            sources: processorProvenanceSources(),
            submittedByHumanId: null,
            reconciledFromProcessor: true,
          }
        : { submittedByHumanId: args.actorHumanId, reconciledFromProcessor: false }),
      submittedAt: now,
      submitError: null,
      processorSubmissionCount: snapshot.evidenceDetails.submissionCount,
    });
    await tx.disputes.updateEvidenceDetails({
      stripeDisputeId: dispute.stripeDisputeId,
      evidenceDueBy: snapshot.evidenceDetails.dueBy,
      evidenceHasEvidence: snapshot.evidenceDetails.hasEvidence,
      evidencePastDue: snapshot.evidenceDetails.pastDue,
      evidenceSubmissionCount: snapshot.evidenceDetails.submissionCount,
      evidenceSubmittedAt: now,
    });
    await tx.audit.log({
      entity: "dispute",
      entityId: dispute.id,
      action: "dispute.evidence_submitted",
      data: {
        actorHumanId: args.actorHumanId,
        stripeDisputeId: dispute.stripeDisputeId,
        assembledVersion: evidence.assembledVersion,
        idempotencyKey: args.processorKey,
        processorStatus: snapshot.status,
        processorSubmissionCount: snapshot.evidenceDetails.submissionCount,
        fieldKeys: Object.keys(
          args.reconciledFromProcessor ? snapshot.evidence : evidence.fields,
        ),
        reconciledFromProcessor: args.reconciledFromProcessor,
      },
      at: now,
    });
    return updated;
  });
}

/**
 * Persists SUBMIT_FAILED + a sanitised message, reports to Sentry, and never
 * throws itself — the caller rethrows the typed error regardless. The write
 * is CAS-guarded on the row that was read under the lock, so it can never
 * fail-stamp a package that has since moved on.
 */
async function recordSubmitFailure(
  deps: SubmitDisputeEvidenceDeps,
  evidence: DisputeEvidenceRecord,
  actorHumanId: string,
  err: unknown,
): Promise<void> {
  const submitError = sanitiseProcessorError(err);
  const disputeId = evidence.disputeId;
  try {
    await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();
      await tx.disputeEvidence.update({
        disputeId,
        expect: { status: "APPROVED", assembledVersion: evidence.assembledVersion },
        status: "SUBMIT_FAILED",
        submitError,
      });
      await tx.audit.log({
        entity: "dispute",
        entityId: disputeId,
        action: "dispute.evidence_submit_failed",
        data: {
          actorHumanId,
          assembledVersion: evidence.assembledVersion,
          submitError,
        },
        at: now,
      });
    });
  } catch (persistErr) {
    deps.logger?.error("dispute.evidence.submit_failure_persist_failed", {
      disputeId,
      error: describeError(persistErr),
    });
  }
  deps.logger?.error("dispute.evidence.submit_failed", {
    disputeId,
    assembledVersion: evidence.assembledVersion,
    error: submitError,
  });
  try {
    deps.reportError?.(err, {
      tags: { useCase: "submitDisputeEvidence" },
      extra: { disputeId, assembledVersion: evidence.assembledVersion, submitError },
    });
  } catch {
    // Reporter failures never change behaviour.
  }
}

function toSubmitError(err: unknown, disputeId: string): unknown {
  // A typed pre-flight error from the adapter (e.g. its own limit check)
  // keeps its code.
  if (err instanceof AppError) return err;
  // Stripe rejects `disputes.update(..., submit: true)` on a dispute that is
  // no longer accepting evidence with an invalid_request_error; the adapter
  // passes it through raw. Map it to the same typed error the live-status
  // guard uses so the desk shows one message for one condition.
  if (isProcessorInvalidRequest(err)) {
    return new AppError("DISPUTE_NOT_ACCEPTING_EVIDENCE", {
      message: "the processor rejected the evidence submission",
      meta: { disputeId, processorError: sanitiseProcessorError(err) },
      cause: err,
    });
  }
  return new AppError("DISPUTE_EVIDENCE_SUBMIT_FAILED", {
    message: "the processor evidence submission failed",
    meta: { disputeId, processorError: sanitiseProcessorError(err) },
    cause: err,
  });
}

function isProcessorInvalidRequest(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: unknown; rawType?: unknown };
  return (
    e.type === "StripeInvalidRequestError" ||
    e.rawType === "invalid_request_error"
  );
}

/**
 * A short, PII-free rendering of a processor error for `submitError`:
 * class + message with emails and IPv4 addresses masked, capped in length.
 * Never the request payload, never headers.
 */
export function sanitiseProcessorError(err: unknown): string {
  const raw =
    err instanceof AppError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? `${err.name}: ${err.message}`
        : describeError(err);
  return raw
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .slice(0, 500);
}
