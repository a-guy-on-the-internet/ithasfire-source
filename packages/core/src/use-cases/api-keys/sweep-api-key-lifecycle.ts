import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  sendApiKeyNotice,
  type ApiKeyNotifier,
  type NoticeDeps,
} from "./_shared/notices";
import {
  sweepApiKeyLifecycleInputSchema,
  type SweepApiKeyLifecycleOutput,
} from "./schemas";

export type SweepApiKeyLifecycleDeps = {
  repos: Pick<Repos, "apiKeys">;
  /**
   * The sweep marks a row as notified BEFORE sending, so it must never run
   * without a notifier (required, as in every notifying use case).
   */
  notifyApiKey: ApiKeyNotifier;
} & NoticeDeps;

const USE_CASE = "sweepApiKeyLifecycle";
const DEFAULT_BATCH = 100;
const DEFAULT_MAX_BATCHES = 20;

/**
 * The daily lifecycle notices (FR-004, FR-005, FR-012), for the step-6 job:
 *  - a pending request unanswered for 14 days: tell the requester it lapsed;
 *  - an approved request not collected in 7 days: tell the requester;
 *  - a live key expiring within 7 days with auto-renew off (key OR request)
 *    and not already renewed: warn the holder.
 *
 * Lapse and expiry themselves are derived from timestamps, never written.
 * What IS written is the send marker (`lapseNotifiedAt` /
 * `expiryNotifiedAt`), by CAS BEFORE the send: two overlapping sweeps cannot
 * both send, and a row is never sent twice. The cost is at-most-once: a send
 * that fails after its mark is not retried. That failure is a deliberate
 * swallow, so it is logged and reported (ReporterPort) and counted in
 * `noticesFailed`; the job decides whether a non-zero count fails the run.
 *
 * Bounded: at most `maxBatches` reads per kind per run.
 */
export async function sweepApiKeyLifecycle(
  deps: SweepApiKeyLifecycleDeps,
  rawInput: unknown = {},
): Promise<SweepApiKeyLifecycleOutput> {
  const input = parseInput(sweepApiKeyLifecycleInputSchema, rawInput);
  const limit = input.batchSize ?? DEFAULT_BATCH;
  const maxBatches = input.maxBatches ?? DEFAULT_MAX_BATCHES;

  const out: SweepApiKeyLifecycleOutput = {
    pendingLapseNoticesSent: 0,
    collectLapseNoticesSent: 0,
    expiryNoticesSent: 0,
    noticesFailed: 0,
    skippedMarkRefused: 0,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const due = await deps.repos.apiKeys.listRequestsDueLapseNotice({ limit });
    for (const { request, kind } of due) {
      const marked = await deps.repos.apiKeys.markRequestLapseNotified({
        requestId: request.id,
      });
      if (!marked) {
        out.skippedMarkRefused++;
        continue;
      }
      const sent = await sendApiKeyNotice(
        deps,
        {
          kind: "request_lapsed",
          audience: { kind: "human", humanId: request.requesterHumanId },
          lapse: kind,
          requestId: request.id,
          subject: request.subject,
          orgId: request.orgId,
          access: request.access,
          label: request.label,
        },
        USE_CASE,
      );
      if (!sent) out.noticesFailed++;
      else if (kind === "pending_lapsed") out.pendingLapseNoticesSent++;
      else out.collectLapseNoticesSent++;
    }
    if (due.length < limit) break;
  }

  for (let batch = 0; batch < maxBatches; batch++) {
    const due = await deps.repos.apiKeys.listKeysDueExpiryNotice({ limit });
    for (const key of due) {
      // The repo lists only expiring keys; a key with no expiry never gets here.
      if (key.expiresAt === null) continue;
      const marked = await deps.repos.apiKeys.markKeyExpiryNotified({
        keyId: key.id,
      });
      if (!marked) {
        out.skippedMarkRefused++;
        continue;
      }
      const sent = await sendApiKeyNotice(
        deps,
        {
          kind: "key_expiring",
          audience: { kind: "human", humanId: key.humanId },
          expiresAt: key.expiresAt,
          keyId: key.id,
          subject: key.subject,
          orgId: key.orgId,
          label: key.label,
          keyLast4: key.keyLast4,
        },
        USE_CASE,
      );
      if (sent) out.expiryNoticesSent++;
      else out.noticesFailed++;
    }
    if (due.length < limit) break;
  }

  return out;
}
