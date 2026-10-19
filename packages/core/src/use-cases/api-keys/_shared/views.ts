import type { Repos } from "@th/ports/repos";
import type {
  ApiKeyListItem,
  ApiKeyRequestRecord,
  ScopedApiKeyRecord,
} from "@th/ports/repos/api-keys";

import type {
  ApiKeyRequestStatus,
  ApiKeyRequestView,
  ApiKeyStatus,
  ApiKeyView,
} from "../schemas";
import {
  addDays,
  COLLECT_WINDOW_DAYS,
  EXPIRY_NOTICE_DAYS,
  REQUEST_LAPSE_DAYS,
  RENEW_WINDOW_DAYS,
} from "./rules";

// ── Derived state (auth.prisma ApiKeyRequest / ApiKey comments) ─────────────
//
// Never a stored flag: every status below is computed from the timestamps and
// withdrawalReason at read time. The DB guards use the same boundaries
// (strictly-after for "still inside the window").

/**
 * A key request's status:
 *  - pending          undecided, not withdrawn, within 14 days of createdAt
 *  - lapsed           undecided, not withdrawn, 14+ days old (FR-004)
 *  - withdrawn        withdrawalReason REQUESTER
 *  - closed_for_account_security  withdrawalReason ACCOUNT_SECURITY (R31):
 *                     a password reset or a ban closed it; never "you withdrew"
 *  - denied           decision DENIED
 *  - ready_to_collect APPROVED, uncollected, within 7 days of decidedAt
 *  - collect_lapsed   APPROVED, uncollected, 7+ days after decidedAt (FR-005)
 *  - collected        APPROVED and collected
 */
export function deriveRequestStatus(
  request: Pick<
    ApiKeyRequestRecord,
    | "createdAt"
    | "decidedAt"
    | "decision"
    | "withdrawnAt"
    | "withdrawalReason"
    | "collectedAt"
  >,
  now: Date,
): ApiKeyRequestStatus {
  if (request.withdrawnAt !== null) {
    return request.withdrawalReason === "ACCOUNT_SECURITY"
      ? "closed_for_account_security"
      : "withdrawn";
  }
  if (request.decision === null || request.decidedAt === null) {
    return addDays(request.createdAt, REQUEST_LAPSE_DAYS) > now
      ? "pending"
      : "lapsed";
  }
  if (request.decision === "DENIED") return "denied";
  if (request.collectedAt !== null) return "collected";
  return addDays(request.decidedAt, COLLECT_WINDOW_DAYS) > now
    ? "ready_to_collect"
    : "collect_lapsed";
}

/** A key's status: revoked, expired or live (legacy keys included). */
export function deriveKeyStatus(
  key: Pick<ScopedApiKeyRecord, "revokedAt" | "expiresAt">,
  now: Date,
): ApiKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt <= now) return "expired";
  return "live";
}

/** Live, expiring, and inside its last 7 days (FR-009 renewal window). */
export function isInRenewWindow(
  key: Pick<ScopedApiKeyRecord, "revokedAt" | "expiresAt">,
  now: Date,
): boolean {
  if (deriveKeyStatus(key, now) !== "live" || key.expiresAt === null) {
    return false;
  }
  return key.expiresAt <= addDays(now, RENEW_WINDOW_DAYS);
}

/** Auto-renew counts as on only when the key AND its request are on. */
export function effectiveAutoRenew(
  key: Pick<ApiKeyListItem, "autoRenew" | "requestAutoRenew">,
): boolean {
  return key.autoRenew && key.requestAutoRenew === true;
}

// ── Audit snapshots ─────────────────────────────────────────────────────────
//
// Audit rows outlive the key and request rows (CASCADE with the holder or the
// org deletes both), so each row carries the scope as it was. Never the key
// hash or plaintext: these shapes have no field for either.

export function requestSnapshot(request: ApiKeyRequestRecord) {
  return {
    requestId: request.id,
    holderHumanId: request.requesterHumanId,
    subject: request.subject,
    orgId: request.orgId,
    access: request.access,
    label: request.label,
    expiryDays: request.expiryDays,
    autoRenew: request.autoRenew,
    decision: request.decision,
    decidedByHumanId: request.decidedByHumanId,
    selfApproved: request.selfApproved,
  };
}

export function keySnapshot(
  key: ScopedApiKeyRecord,
  request?: Pick<
    ApiKeyRequestRecord,
    "decidedByHumanId" | "selfApproved"
  > | null,
) {
  return {
    keyId: key.id,
    requestId: key.requestId,
    holderHumanId: key.humanId,
    subject: key.subject,
    orgId: key.orgId,
    access: key.access,
    label: key.label,
    keyLast4: key.keyLast4,
    expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    renewedFromKeyId: key.renewedFromKeyId,
    decidedByHumanId: request?.decidedByHumanId ?? null,
    selfApproved: request?.selfApproved ?? false,
  };
}

/** Who acted: the human, and the key they acted with (NFR-001). */
export function actorFields(input: {
  actorHumanId: string | null;
  actingApiKeyId?: string | null;
}) {
  return {
    actorHumanId: input.actorHumanId,
    actingApiKeyId: input.actingApiKeyId ?? null,
  };
}

// ── Screen rows (never the hash) ────────────────────────────────────────────

/** Display names for the ids the repo returns (holder, approver, requester). */
export async function resolveNames(
  repos: { humans: Pick<Repos["humans"], "getByIds"> },
  ids: Iterable<string | null>,
): Promise<Map<string, string | null>> {
  const unique = [...new Set([...ids].filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const humans = await repos.humans.getByIds(unique);
  return new Map(humans.map((h) => [h.id, h.name]));
}

export function toKeyView(
  key: ApiKeyListItem,
  now: Date,
  names: Map<string, string | null>,
  extra: { canRevoke: boolean },
): ApiKeyView {
  const status = deriveKeyStatus(key, now);
  const expiringSoon =
    status === "live" &&
    key.expiresAt !== null &&
    key.expiresAt <= addDays(now, EXPIRY_NOTICE_DAYS);
  return {
    id: key.id,
    requestId: key.requestId,
    holderHumanId: key.humanId,
    holderName: names.get(key.humanId) ?? null,
    subject: key.subject,
    orgId: key.orgId,
    access: key.access,
    label: key.label,
    purpose: key.purpose,
    keyLast4: key.keyLast4,
    legacy: key.subject === null,
    status,
    expiringSoon,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    autoRenew: effectiveAutoRenew(key),
    holderAutoRenew: key.autoRenew,
    renewalLockedOff: key.subject !== null && key.requestAutoRenew !== true,
    renewedFromKeyId: key.renewedFromKeyId,
    revokedAt: key.revokedAt,
    revokedByHumanId: key.revokedByHumanId,
    revokedByName: key.revokedByHumanId
      ? (names.get(key.revokedByHumanId) ?? null)
      : null,
    revokeReason: key.revokeReason,
    decidedByHumanId: key.decidedByHumanId,
    decidedByName: key.decidedByHumanId
      ? (names.get(key.decidedByHumanId) ?? null)
      : null,
    selfApproved: key.selfApproved,
    canRevoke: extra.canRevoke && status !== "revoked",
  };
}

export function toRequestView(
  request: ApiKeyRequestRecord,
  now: Date,
  names: Map<string, string | null>,
  extra: { canDecide: boolean; canSelfApprove: boolean },
): ApiKeyRequestView {
  const status = deriveRequestStatus(request, now);
  return {
    id: request.id,
    requesterHumanId: request.requesterHumanId,
    requesterName: names.get(request.requesterHumanId) ?? null,
    subject: request.subject,
    orgId: request.orgId,
    access: request.access,
    label: request.label,
    purpose: request.purpose,
    expiryDays: request.expiryDays,
    autoRenew: request.autoRenew,
    status,
    createdAt: request.createdAt,
    lapsesAt:
      status === "pending"
        ? addDays(request.createdAt, REQUEST_LAPSE_DAYS)
        : status === "ready_to_collect" && request.decidedAt
          ? addDays(request.decidedAt, COLLECT_WINDOW_DAYS)
          : null,
    decidedAt: request.decidedAt,
    decision: request.decision,
    decidedByHumanId: request.decidedByHumanId,
    decidedByName: request.decidedByHumanId
      ? (names.get(request.decidedByHumanId) ?? null)
      : null,
    denialReason: request.denialReason,
    selfApproved: request.selfApproved,
    withdrawnAt: request.withdrawnAt,
    collectedAt: request.collectedAt,
    canDecide: extra.canDecide && status === "pending",
    canSelfApprove: extra.canSelfApprove && status === "pending",
  };
}
