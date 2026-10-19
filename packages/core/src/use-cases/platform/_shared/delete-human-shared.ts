import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import { fail } from "@th/errors";

import { extractStorageKeyFromUrl } from "../../profiles/storage-url";

// ─────────────────────────────────────────────────────────────────────────────
// Shared human-deletion transaction executor.
//
// Both the staff-initiated hard delete (`admin-delete-human.ts`) and the
// self-serve delete (`humans/delete-my-account.ts`) need the exact same
// transactional sequence: guard checks, audit log BEFORE delete (the row
// won't exist after), then GDPR/CCPA free-text scrub, entity-page teardown
// (+ R2 cleanup enqueue), then the hard delete itself. This lives here so
// neither call site can drift from the other.
//
// See docs/account-deletion.md for the full deleted/retained/detached
// inventory this sequence implements.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecuteHumanDeletionTxDeps = {
  repos: Pick<
    Repos,
    | "humans"
    | "audit"
    | "tx"
    | "supportThreads"
    | "organizations"
    | "entityPages"
    | "pendingObjectDeletions"
    | "resourceQuotas"
    | "savedSnippets"
  >;
  logger?: LoggerPort;
};

export type ExecuteHumanDeletionTxParams = {
  humanId: string;
  actorHumanId: string;
  actorKind: "staff" | "self";
  deletedEmail: string;
  deletedName: string | null;
};

/**
 * Storage-key namespaces a human's own page media can legitimately live in:
 * the avatar/banner upload flows (`avatars/human/…` / `banners/human/…`, see
 * set-avatar-from-upload / set-banner-from-upload) and the entity-page image
 * flow (`getEntityPageImageKeyPrefix("HUMAN", humanId)` →
 * `entity-pages/human/…`).
 *
 * SECURITY: `updatePage` accepts arbitrary absolute URLs for
 * avatarUrl/bannerUrl (only `z.string().url()` validation), and public R2
 * URLs expose object keys directly (`${publicBaseUrl}/${key}`). Without this
 * allowlist an attacker could set a VICTIM's public media URL as their own
 * page avatar, delete their account, and enqueue the victim's object for
 * deletion. Off-prefix keys are dropped silently — same posture as the
 * `startsWith(expectedPrefix)` guard the upload flows already apply before
 * deleting replaced objects (set-avatar-from-upload.ts).
 */
function ownedPageMediaPrefixes(humanId: string): string[] {
  return [
    `avatars/human/${humanId}/`,
    `banners/human/${humanId}/`,
    `entity-pages/human/${humanId}/`,
  ];
}

export async function executeHumanDeletionTx(
  deps: ExecuteHumanDeletionTxDeps,
  params: ExecuteHumanDeletionTxParams,
): Promise<void> {
  const { humanId, actorHumanId, actorKind, deletedEmail, deletedName } =
    params;

  // Wrap guards + audit + delete in a single transaction.
  // Audit BEFORE deletion (the human row won't exist after).
  await deps.repos.tx(async (tx) => {
    // Guard: the Human FK on Order/Ticket/TicketScan/TicketTransfer/
    // PendingTicketTransfer/Claim/ResaleListing/ResaleListingHold is
    // ON DELETE RESTRICT — these are financial records retained for
    // accounting/audit, and deleting a human with any such history would
    // otherwise crash with an unhandled Postgres FK-constraint violation.
    // (Non-financial creator references — images, templates, series, layouts,
    // embeds, audio, attestations, verification requests — are SetNull and
    // detach instead of blocking.)
    const blockedByHistory =
      await tx.humans.hasDeletionBlockingHistory(humanId);
    if (blockedByHistory) {
      throw fail("CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY");
    }

    // Guard: OrgMember.human is ON DELETE CASCADE — deleting the sole OWNER
    // of an org would silently orphan it. Mirrors the CANNOT_REMOVE_LAST_OWNER
    // guard in remove-org-member.ts, and takes the same per-org roster lock
    // first, for every org the human belongs to: without it a co-owner
    // leaving, or an ownership transfer to this human, at the same moment
    // gets past the check and the org ends with no OWNER.
    await tx.organizations.lockOwnerRostersForMember(humanId);
    const soleOwner = await tx.organizations.isSoleOwnerOfAnyOrg(humanId);
    if (soleOwner) {
      throw fail("CANNOT_DELETE_SOLE_ORG_OWNER");
    }

    await tx.audit.log({
      entity: "Human",
      entityId: humanId,
      action: actorKind === "staff" ? "admin.deleteHuman" : "self.deleteAccount",
      data: {
        actorHumanId,
        actorKind,
        deletedEmail,
        deletedName,
      },
    });

    // GDPR/CCPA erasure: scrub the user's free-text support messages and drop
    // author-id links BEFORE deleting the Human. The SupportThread.human FK is
    // ON DELETE SET NULL, so the human row delete nulls each thread's humanId
    // (owner-less, staff-only), but SupportMessage.authorHumanId has no FK and
    // its free-text body would otherwise survive — scrub it here, same tx.
    const scrub = await tx.supportThreads.scrubHumanSupportContent({
      humanId,
      tombstone: "[deleted]",
    });

    // The human's public EntityPage is polymorphic (ownerType/ownerId, no FK
    // to Human), so the hard delete below would NOT touch it — the profile
    // (displayName, bio, avatar/banner URLs, slug) would survive as a public
    // orphan. Tear it down here, same tx. Read it first: the avatar/banner
    // object keys must be derived from its URLs BEFORE the row is gone.
    const page = await tx.entityPages.getByOwner("HUMAN", humanId);
    let pageObjectKeys: string[] = [];
    if (page) {
      // Public URLs are `${publicBaseUrl}/${key}`, so pathname == key. Only
      // the CURRENT avatar/banner objects are enqueued — older dated uploads
      // under avatars/human/{humanId}/ that were replaced without cleanup are
      // covered by the detached-path sweep follow-up (docs/account-deletion.md).
      //
      // Keys outside the human's own media namespaces are dropped: the URLs
      // are client-writable (updatePage), so anything off-prefix could point
      // at ANOTHER entity's object — never enqueue those (see
      // ownedPageMediaPrefixes above).
      const ownedPrefixes = ownedPageMediaPrefixes(humanId);
      pageObjectKeys = [
        extractStorageKeyFromUrl(page.avatarUrl),
        extractStorageKeyFromUrl(page.bannerUrl),
      ]
        .filter((key): key is string => key !== null)
        .filter((key) =>
          ownedPrefixes.some((prefix) => key.startsWith(prefix)),
        );

      // Same transactional-outbox pattern as deleteEvent: enqueue the delete
      // intents in the SAME tx as the row teardown so they commit atomically;
      // the drain job (storage.drain-pending-deletions) removes the objects
      // durably with retries.
      const deletionItems: EnqueuePendingObjectDeletionItem[] =
        pageObjectKeys.map((targetKey) => ({
          targetKey,
          targetKind: "KEY" as const,
          source: "human_delete",
          sourceId: humanId,
        }));
      await tx.pendingObjectDeletions.enqueueMany(deletionItems);

      // Theme, blocks, slug history, and follows cascade off the page row.
      await tx.entityPages.deleteByOwner("HUMAN", humanId);
    }

    // Storage-quota usage rows are polymorphic too (subjectType/subjectId, no
    // FK) — drop the human's row instead of leaving an orphan. Idempotent
    // no-op when absent.
    await tx.resourceQuotas.deleteUsage({
      subjectType: "HUMAN",
      subjectId: humanId,
      kind: "STORAGE_BYTES_HUMAN",
    });

    // The human's saved snippets (reusable reasons — booking-the-night
    // FR-013) and their list rows are polymorphic too (ownerType/ownerId, no
    // FK): free text the person wrote, so it goes with them. Idempotent no-op
    // when they have none.
    const snippets = await tx.savedSnippets.deleteByOwner({
      ownerType: "HUMAN",
      ownerId: humanId,
    });

    // Hard-delete — Prisma cascades handle AuthUser → AuthAccount, AuthSession,
    // Passkey, AuthTwoFactor. The SupportThread.human FK (SetNull) nulls each
    // thread's humanId here, and the creator-attribution FKs (images,
    // templates, series, layouts, embeds, audio, attestations, verification
    // requests) SetNull their references.
    await tx.humans.deleteHuman(humanId);

    deps.logger?.info("deleteHuman.support_scrubbed", {
      humanId,
      supportMessagesScrubbed: scrub.messagesScrubbed,
      supportAuthorLinksCleared: scrub.authorLinksCleared,
      entityPageDeleted: page !== null,
      storageObjectsEnqueued: pageObjectKeys.length,
      savedSnippetsDeleted: snippets.deleted,
    });
  });
}
