import type { TxRepos } from "@th/ports/repos";
import type {
  ResourceLimitKind,
  QuotaSubjectType,
} from "@th/ports/repos/resource-quotas";
import { QUOTA_UNLIMITED } from "@th/types/repos/resource-quotas";

/**
 * Check whether adding `delta` units would exceed the subject's effective quota.
 *
 * Call this inside a transaction before creating the resource. If the quota
 * would be exceeded, it throws `{ code: "forbidden", message: "quota_exceeded" }`
 * with additional context the UI can use to show a "request expansion" prompt.
 *
 * Does NOT modify the usage counter — call `incrementResourceUsage` after the
 * resource is actually created.
 */
export async function enforceQuota(
  tx: TxRepos,
  input: {
    subjectType: QuotaSubjectType;
    subjectId: string;
    kind: ResourceLimitKind;
    delta?: bigint;
  },
): Promise<void> {
  const delta = input.delta ?? 1n;

  const quota = await tx.resourceQuotas.getEffectiveQuota({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    kind: input.kind,
  });

  // Skip enforcement when the effective limit is the "unlimited" sentinel
  // (e.g. EVENTS_PER_ORG for established orgs at trust level 2+).
  if (quota.limitValue >= QUOTA_UNLIMITED) return;

  if (quota.currentUsage + delta > quota.limitValue) {
    const hasPending = await tx.resourceQuotas.hasPendingExpansionRequest({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
    });

    throw {
      code: "forbidden" as const,
      message: "quota_exceeded" as const,
      meta: {
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        limitValue: quota.limitValue.toString(),
        currentUsage: quota.currentUsage.toString(),
        hasPendingExpansionRequest: hasPending,
      },
    };
  }
}

/**
 * Convenience: increment usage counter after resource creation.
 * Safe to call inside the same transaction as the resource creation.
 */
export async function incrementResourceUsage(
  tx: TxRepos,
  input: {
    subjectType: QuotaSubjectType;
    subjectId: string;
    kind: ResourceLimitKind;
    delta?: bigint;
  },
) {
  return tx.resourceQuotas.incrementUsage({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    kind: input.kind,
    delta: input.delta ?? 1n,
  });
}
