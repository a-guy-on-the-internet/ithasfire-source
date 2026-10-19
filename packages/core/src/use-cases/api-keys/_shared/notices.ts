import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { ApiKeyAccess, ApiKeySubject } from "@th/ports/repos/api-keys";

/**
 * FR-012 notices (in-app + email), as facts core decided to announce. The
 * notifier hook is composed by the composition root (plan step 5), which
 * resolves an audience to humans, renders and sends; core decides WHO is
 * told (the audience rule) and WHAT happened.
 *
 * A notice never carries a key's plaintext or hash: the shapes below have no
 * field for either.
 */
export type ApiKeyNoticeAudience =
  /** The org's live OWNERs / ADMINs, minus `excludeHumanId` (the requester or holder). */
  | { kind: "org_admins"; orgId: string; excludeHumanId: string }
  /** Platform staff holding one of `roles` (Key scopes table). */
  | { kind: "platform_staff"; roles: readonly string[] }
  | { kind: "human"; humanId: string };

type RequestFacts = {
  requestId: string;
  subject: ApiKeySubject;
  orgId: string | null;
  access: ApiKeyAccess;
  label: string;
};

type KeyFacts = {
  keyId: string;
  subject: ApiKeySubject | null;
  orgId: string | null;
  label: string | null;
  keyLast4: string | null;
};

export type ApiKeyNotice =
  /** Approvers, when a request arrives. */
  | ({
      kind: "request_submitted";
      audience: ApiKeyNoticeAudience;
      requesterHumanId: string;
    } & RequestFacts)
  /** The requester, on approval (collect within 7 days). */
  | ({
      kind: "request_approved";
      audience: { kind: "human"; humanId: string };
      collectBy: Date;
    } & RequestFacts)
  /** The requester, on denial, with the reason (FR-004). */
  | ({
      kind: "request_denied";
      audience: { kind: "human"; humanId: string };
      denialReason: string;
    } & RequestFacts)
  /** The requester: pending 14 days unanswered, or approved and not collected in 7. */
  | ({
      kind: "request_lapsed";
      audience: { kind: "human"; humanId: string };
      lapse: "pending_lapsed" | "collect_lapsed";
    } & RequestFacts)
  /** The holder, 7 days before expiry, only when auto-renew is off (FR-012). */
  | ({
      kind: "key_expiring";
      audience: { kind: "human"; humanId: string };
      expiresAt: Date;
    } & KeyFacts)
  /** The holder, when someone else revoked their key (FR-010 reason shown). */
  | ({
      kind: "key_revoked";
      audience: { kind: "human"; humanId: string };
      revokedBy: "org_admin" | "staff_admin";
      reason: string | null;
      revokedKeyIds: string[];
    } & KeyFacts)
  /** An org's OWNERs / ADMINs, when a key on their org is collected. */
  | ({
      kind: "key_collected";
      audience: ApiKeyNoticeAudience;
      holderHumanId: string;
    } & KeyFacts)
  /** An org's OWNERs / ADMINs, when a key on their org renews itself. */
  | ({
      kind: "key_renewed";
      audience: ApiKeyNoticeAudience;
      holderHumanId: string;
      renewedFromKeyId: string;
    } & KeyFacts);

export type ApiKeyNotifier = (notice: ApiKeyNotice) => Promise<void>;

export type NoticeDeps = {
  /**
   * REQUIRED: a use case that announces something must be wired to a
   * notifier, so a composition root that forgot it fails to typecheck
   * instead of silently sending nothing.
   */
  notifyApiKey: ApiKeyNotifier;
  logger?: LoggerPort;
  /** ReporterPort convention: a throwing reporter never changes behaviour. */
  reportError?: ReporterPort;
};

/**
 * Send a notice after the transaction committed. A DELIBERATE SWALLOW
 * (NFR-006): a failed send never undoes or fails the committed change, so the
 * failure is logged AND reported (CLAUDE.md "Error Reporting Convention").
 * Returns whether the send succeeded (the sweep counts failures).
 */
export async function sendApiKeyNotice(
  deps: NoticeDeps,
  notice: ApiKeyNotice,
  useCase: string,
): Promise<boolean> {
  try {
    await deps.notifyApiKey(notice);
    return true;
  } catch (error) {
    deps.logger?.error("api_keys.notice_failed", {
      useCase,
      notice: notice.kind,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase, notice: notice.kind },
        extra: noticeIds(notice),
      });
    } catch {
      // Reporting is best-effort: a throwing reporter must never turn a
      // swallowed notice failure into a failed mutation.
    }
    return false;
  }
}

function noticeIds(notice: ApiKeyNotice): Record<string, unknown> {
  return "requestId" in notice
    ? { requestId: notice.requestId }
    : { keyId: notice.keyId };
}
