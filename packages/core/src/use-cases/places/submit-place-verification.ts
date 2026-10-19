import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { PlaceVerificationStatus, Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import { z } from "zod";
import { fail } from "@th/errors";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { verifyPlaceDocumentUploads } from "./_shared/verify-place-document-uploads";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS = 5;

const documentSchema = z.object({
  storageKey: z.string().min(1),
  fileName: z.string().min(1).max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOC_BYTES),
});

export const submitPlaceVerificationInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    orgId: z.string().uuid(),
    /**
     * Newly uploaded documents for this request. Can be empty when the caller
     * is reusing documents from a previous (rejected/withdrawn) request via
     * `reuseFromRequestId` — the use case validates that the combined set
     * has at least one document.
     */
    documents: z.array(documentSchema).max(MAX_DOCUMENTS),
    /**
     * When provided, the documents from the referenced (rejected or
     * withdrawn) request are linked to the new request so the organizer
     * doesn't have to re-upload after a rejection. The source request must
     * belong to the same place + org. Defaulted to ON in the UI for
     * resubmissions but the value itself is opt-in: callers must pass an
     * explicit request ID.
     */
    reuseFromRequestId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const submitPlaceVerificationOutputSchema = z
  .object({
    requestId: z.string().uuid(),
    /**
     * True when the returned request was already open (PENDING / IN_REVIEW)
     * and we returned it instead of creating a new one. The UI uses this to
     * decide whether to show "submitted!" vs "you already have one open".
     */
    reusedActiveRequest: z.boolean(),
    /** Number of documents reused from a prior request (0 when none). */
    reusedDocumentCount: z.number().int().nonnegative(),
  })
  .strict();

export type SubmitPlaceVerificationInput = z.infer<
  typeof submitPlaceVerificationInputSchema
>;
export type SubmitPlaceVerificationOutput = z.infer<
  typeof submitPlaceVerificationOutputSchema
>;

export type SubmitPlaceVerificationDeps = {
  repos: Pick<
    Repos,
    | "places"
    | "placeVerificationRequests"
    | "placeVerificationDocuments"
    | "authz"
    | "audit"
    | "tx"
  >;
  authz: Pick<AuthZPort, "hasOrgRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * HEADs each newly submitted document: key must be this place's, the object
   * must exist, and be no bigger than declared (F11).
   */
  storage: Pick<FileStoragePort, "headObject" | "deleteObject">;
  /** Reports a failed delete of an oversize document (deliberate swallow). */
  reportError?: ReporterPort;
};

/**
 * Submits a place verification request with supporting documents.
 *
 * Idempotent: if an active (PENDING / IN_REVIEW) request already exists for
 * this place, returns that request instead of creating a duplicate. After a
 * REJECTED or WITHDRAWN decision the organizer can resubmit unconditionally,
 * optionally reusing documents from the previous request.
 *
 * Gated by org OWNER/ADMIN role on the org that owns the place.
 */
export async function submitPlaceVerification(
  deps: SubmitPlaceVerificationDeps,
  rawInput: unknown,
): Promise<SubmitPlaceVerificationOutput> {
  const logger = deps.logger?.child({ useCase: "submitPlaceVerification" });

  const execute = async () => {
    const input = parseInput(submitPlaceVerificationInputSchema, rawInput);

    const perm = await deps.authz.hasOrgRole({
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      requiredRoles: [...ORG_ADMIN_ROLES],
    });
    if (!perm.allowed) {
      throw fail("INSUFFICIENT_ROLE");
    }

    const place = await deps.repos.places.getById(input.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }

    if (!place.orgIdsWithAccess.includes(input.orgId)) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
    }

    // Idempotency: an existing active request short-circuits the submit. The
    // organizer-side UI should also prevent this, but the server is the one
    // that has to be right under double-clicks and stale tabs.
    const active = await deps.repos.placeVerificationRequests.getActiveForPlace(
      input.placeId,
    );
    if (active) {
      return submitPlaceVerificationOutputSchema.parse({
        requestId: active.id,
        reusedActiveRequest: true,
        reusedDocumentCount: 0,
      });
    }

    // Resolve documents to reuse from a prior request, if requested. Cap the
    // total at MAX_DOCUMENTS so a misbehaving client can't smuggle 50 files
    // forward by chaining reuses.
    let reusedDocs: {
      storageKey: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    }[] = [];
    if (input.reuseFromRequestId) {
      const source = await deps.repos.placeVerificationRequests.getById(
        input.reuseFromRequestId,
      );
      if (!source) {
        throw fail("PLACE_NOT_FOUND", { meta: { role: "reuse_source" } });
      }
      // Cross-org reuse would leak document access; clamp to the same place + org.
      if (source.placeId !== input.placeId || source.orgId !== input.orgId) {
        throw fail("REUSE_SOURCE_NOT_OWNED");
      }
      // Active sources would mean we'd attach docs to two open requests at once.
      if (source.status === "PENDING" || source.status === "IN_REVIEW") {
        throw fail("REUSE_SOURCE_STILL_ACTIVE");
      }
      const sourceDocs =
        await deps.repos.placeVerificationDocuments.listByRequestId(
          input.reuseFromRequestId,
        );
      reusedDocs = sourceDocs
        .filter((d) => !d.deletedAt)
        .map((d) => ({
          storageKey: d.storageKey,
          fileName: d.fileName,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
        }));
    }

    const totalDocs = input.documents.length + reusedDocs.length;
    if (totalDocs < 1) {
      throw fail("DOCUMENTS_REQUIRED");
    }
    if (totalDocs > MAX_DOCUMENTS) {
      throw fail("TOO_MANY_DOCUMENTS");
    }

    // Only the NEW documents: reused ones were checked on first submit.
    await verifyPlaceDocumentUploads(
      { storage: deps.storage, logger, reportError: deps.reportError },
      {
        placeId: input.placeId,
        documents: input.documents,
        context: "submitPlaceVerification",
      },
    );

    const now = deps.clock.now();
    return deps.repos.tx(async (tx) => {
      // The claim lock serialises this with claim submit / review, the staff
      // verification flips and the owner status change, which all take it.
      // The checks above ran on a read taken before the document HEADs; they
      // are repeated here on the row as it is now.
      await tx.places.lockPlaceForClaim(input.placeId);
      const lockedPlace = await tx.places.getById(input.placeId);
      if (!lockedPlace) {
        throw fail("PLACE_NOT_FOUND");
      }
      if (!lockedPlace.orgIdsWithAccess.includes(input.orgId)) {
        throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
      }
      // A double-click / second tab that filed a request while this one
      // waited: hand back that request, as the check above would have.
      const activeNow = await tx.placeVerificationRequests.getActiveForPlace(
        input.placeId,
      );
      if (activeNow) {
        return submitPlaceVerificationOutputSchema.parse({
          requestId: activeNow.id,
          reusedActiveRequest: true,
          reusedDocumentCount: 0,
        });
      }
      assertVerificationSubmittable(lockedPlace.verificationStatus);

      const request = await tx.placeVerificationRequests.create({
        placeId: input.placeId,
        orgId: input.orgId,
        submittedById: input.actorHumanId,
      });

      await tx.placeVerificationDocuments.createMany({
        requestId: request.id,
        documents: [
          ...reusedDocs,
          ...input.documents.map((d) => ({
            storageKey: d.storageKey,
            fileName: d.fileName,
            contentType: d.contentType,
            sizeBytes: d.sizeBytes,
          })),
        ],
      });

      // Compare-and-set of `verification` alone, from the status read under
      // the lock. It used to rebuild the whole row through `places.upsert`,
      // which overwrote a concurrent name/address edit and wrote a NULL
      // street line / country back as "".
      const { changed } = await tx.places.setVerificationStatus({
        placeId: input.placeId,
        from: lockedPlace.verificationStatus,
        to: "PENDING",
      });
      if (!changed) {
        // A writer that skips the claim lock moved the status between the
        // read and the write. VERIFIED / PENDING now are refused with the
        // codes above; any other move is CONFLICT ("refresh and try again").
        const after = await tx.places.getById(input.placeId);
        if (!after) {
          throw fail("PLACE_NOT_FOUND");
        }
        assertVerificationSubmittable(after.verificationStatus);
        throw fail("CONFLICT", {
          meta: {
            reason: "place_verification_changed",
            placeId: input.placeId,
            expected: lockedPlace.verificationStatus,
          },
        });
      }

      await tx.audit.log({
        entity: "place_verification_request",
        entityId: request.id,
        action: "verification_submitted",
        data: {
          placeId: input.placeId,
          orgId: input.orgId,
          submittedById: input.actorHumanId,
          documentCount: totalDocs,
          reusedDocumentCount: reusedDocs.length,
          reuseFromRequestId: input.reuseFromRequestId ?? null,
        },
        at: now,
      });

      // verification is on the place's search document.
      await markForSearchReindex(tx, [{ kind: "place", id: input.placeId }], now);

      return submitPlaceVerificationOutputSchema.parse({
        requestId: request.id,
        reusedActiveRequest: false,
        reusedDocumentCount: reusedDocs.length,
      });
    });
  };

  if (logger) {
    return logger.withTime("submitPlaceVerification", execute);
  }

  return execute();
}

/**
 * Only an UNVERIFIED or REJECTED place goes to PENDING. A VERIFIED place
 * (verified by staff or a claim) is refused rather than demoted, and a
 * PENDING one (a claim in review) is refused rather than given a second open
 * request. Own codes, not the claim flow's: their copy speaks to a rival
 * claimant, not an org verifying its own place.
 */
function assertVerificationSubmittable(
  status: PlaceVerificationStatus,
): void {
  if (status === "VERIFIED") {
    throw fail("PLACE_ALREADY_VERIFIED");
  }
  if (status === "PENDING") {
    throw fail("VERIFICATION_ALREADY_PENDING");
  }
}
