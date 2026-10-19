import type {
  AcceptanceDocumentType,
  AcceptanceRecordRow,
  AcceptanceScope,
} from "@th/ports/repos/acceptances";
import type { TxRepos } from "@th/ports/repos";

import {
  CURRENT_CHARGEBACK_TERMS_TEXT,
  CURRENT_CHARGEBACK_TERMS_VERSION,
} from "../payments/chargeback-terms";
import {
  CURRENT_REFUND_POLICY_TEXT,
  CURRENT_REFUND_POLICY_VERSION,
} from "../payments/refund-policy";
import {
  CURRENT_BUYER_TERMS_TEXT,
  CURRENT_BUYER_TERMS_VERSION,
} from "./buyer-terms";

export type DocumentSpec = {
  type: AcceptanceDocumentType;
  currentVersion: string;
  currentText: string;
  scopeType: AcceptanceScope;
};

/**
 * Central registry — single source of truth for the current version + text of
 * each platform-wide, human-keyed, version-gated document.
 *
 * Only documents that are actually plumbed through today appear here. Future
 * documents (ORGANIZER_TERMS, PRIVACY_POLICY, AGE_VERIFICATION) register
 * themselves when they ship — `getDocumentSpec` throws if asked for a type
 * that has not been registered yet, which surfaces the omission loudly
 * rather than silently writing an empty snapshot.
 *
 * BUYER_TERMS and REFUND_POLICY are dual-written by the buyer checkout flows
 * (createCheckout / claimFreeTickets / createResaleCheckout; embed guest
 * checkout inherits via delegation): the Order keeps its point-in-time
 * stamps, and one GLOBAL-scope ledger row per human per document version is
 * written here. See docs/specs/2026-06-10/completed/buyer-tos-refund-policy-persistence.spec.md.
 */
export const DOCUMENT_REGISTRY: Partial<
  Record<AcceptanceDocumentType, DocumentSpec>
> = {
  CHARGEBACK_TERMS_ORGANIZER: {
    type: "CHARGEBACK_TERMS_ORGANIZER",
    currentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
    currentText: CURRENT_CHARGEBACK_TERMS_TEXT,
    scopeType: "ORGANIZATION",
  },
  BUYER_TERMS: {
    type: "BUYER_TERMS",
    currentVersion: CURRENT_BUYER_TERMS_VERSION,
    currentText: CURRENT_BUYER_TERMS_TEXT,
    scopeType: "GLOBAL",
  },
  REFUND_POLICY: {
    type: "REFUND_POLICY",
    currentVersion: CURRENT_REFUND_POLICY_VERSION,
    currentText: CURRENT_REFUND_POLICY_TEXT,
    scopeType: "GLOBAL",
  },
};

export function getDocumentSpec(
  documentType: AcceptanceDocumentType,
): DocumentSpec {
  const spec = DOCUMENT_REGISTRY[documentType];
  if (!spec) {
    throw {
      code: "invalid_input",
      message: `acceptance_document_not_registered:${documentType}`,
    } as const;
  }
  return spec;
}

/**
 * Has the human accepted the *current* version of the document in the given
 * scope? A version bump in the registry invalidates all prior acceptances and
 * makes this return false until the human re-accepts.
 */
export async function hasCurrentAcceptance(input: {
  repos: Pick<TxRepos, "acceptances">;
  humanId: string;
  documentType: AcceptanceDocumentType;
  scopeType?: AcceptanceScope;
  scopeId?: string | null;
}): Promise<boolean> {
  const spec = getDocumentSpec(input.documentType);
  const existing = await input.repos.acceptances.findCurrent({
    humanId: input.humanId,
    documentType: input.documentType,
    documentVersion: spec.currentVersion,
    scopeType: input.scopeType ?? spec.scopeType,
    scopeId: input.scopeId ?? null,
  });
  return existing !== null;
}

/**
 * Records the human's acceptance of the current version of a document.
 * Idempotent: if the human already has a current-version acceptance in the
 * same scope, the existing row is returned unchanged.
 *
 * The find-then-create below races under concurrency (two first purchases
 * by the same human can both miss findCurrent). The find is just a cheap
 * fast path to avoid pointless inserts — the real guarantee is the DB
 * unique index on (humanId, documentType, documentVersion, scopeType,
 * scopeId) NULLS NOT DISTINCT, which `acceptances.create` honors
 * duplicate-safely: the race loser gets the winner's row back and the
 * surrounding transaction is never aborted.
 */
export async function recordAcceptance(input: {
  repos: Pick<TxRepos, "acceptances">;
  humanId: string;
  documentType: AcceptanceDocumentType;
  scopeType: AcceptanceScope;
  scopeId?: string | null;
  acceptedAt?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AcceptanceRecordRow> {
  const spec = getDocumentSpec(input.documentType);

  const existing = await input.repos.acceptances.findCurrent({
    humanId: input.humanId,
    documentType: input.documentType,
    documentVersion: spec.currentVersion,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
  });
  if (existing) {
    return existing;
  }

  return input.repos.acceptances.create({
    humanId: input.humanId,
    documentType: input.documentType,
    documentVersion: spec.currentVersion,
    documentTextSnapshot: spec.currentText,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    acceptedAt: input.acceptedAt,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata ?? null,
  });
}
