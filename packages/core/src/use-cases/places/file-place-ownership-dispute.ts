import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import { ownerToPair } from "./_shared/claim";
import { assertPlaceDisputable } from "./_shared/claim-eligibility";
import {
  notifyAdminsOfClaim,
  notifyOwnerOfDispute,
} from "./_shared/claim-notifications";
import { z } from "zod";
import { fail } from "@th/errors";
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

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), humanId: z.string().uuid() }),
  z.object({ kind: z.literal("org"), orgId: z.string().uuid() }),
]);

export const filePlaceOwnershipDisputeInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    owner: ownerSchema,
    reason: z.string().trim().min(10).max(2000),
    documents: z.array(documentSchema).max(MAX_DOCUMENTS).optional(),
  })
  .strict();

export const filePlaceOwnershipDisputeOutputSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();

export type FilePlaceOwnershipDisputeInput = z.infer<
  typeof filePlaceOwnershipDisputeInputSchema
>;
export type FilePlaceOwnershipDisputeOutput = z.infer<
  typeof filePlaceOwnershipDisputeOutputSchema
>;

export type FilePlaceOwnershipDisputeDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "places"
    | "placeVerificationRequests"
    | "placeVerificationDocuments"
    | "audit"
    | "authz"
    | "notifications"
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
 * FR-008. For a place that already has a VERIFIED owner (or Place.verification
 * == VERIFIED), file an OWNERSHIP_DISPUTE routed to platform admins. NEVER
 * mutates ownership — disputes are always admin-resolved (no auto-approve).
 * A reason is required. Notifies the current verified owner + admins.
 */
export async function filePlaceOwnershipDispute(
  deps: FilePlaceOwnershipDisputeDeps,
  rawInput: unknown,
): Promise<FilePlaceOwnershipDisputeOutput> {
  const logger = deps.logger?.child({ useCase: "filePlaceOwnershipDispute" });

  const execute = async () => {
    const input = parseInput(filePlaceOwnershipDisputeInputSchema, rawInput);
    const { ownerType, ownerId } = ownerToPair(input.owner);

    // Authorize the disputing party's identity.
    if (input.owner.kind === "human") {
      if (input.owner.humanId !== input.actorHumanId) {
        throw fail("HUMAN_MISMATCH");
      }
    } else {
      const perm = await deps.authz.hasOrgRole({
        actorHumanId: input.actorHumanId,
        orgId: input.owner.orgId,
        requiredRoles: [...ORG_ADMIN_ROLES],
      });
      if (!perm.allowed) {
        throw fail("INSUFFICIENT_ROLE");
      }
    }

    // Shared predicate — identical to the doc-upload presign's dispute context.
    const { place, verifiedOwner } = await assertPlaceDisputable(
      deps,
      input.placeId,
    );

    const now = deps.clock.now();
    const documents = input.documents ?? [];

    await verifyPlaceDocumentUploads(
      { storage: deps.storage, logger, reportError: deps.reportError },
      {
        placeId: input.placeId,
        documents,
        context: "filePlaceOwnershipDispute",
      },
    );

    const requestId = await deps.repos.tx(async (tx) => {
      const request = await tx.placeVerificationRequests.create({
        placeId: input.placeId,
        orgId: input.owner.kind === "org" ? input.owner.orgId : null,
        submittedById: input.actorHumanId,
        source: "OWNERSHIP_DISPUTE",
        claimantHumanId: input.actorHumanId,
        claimOwnerType: ownerType,
        claimOwnerId: ownerId,
        ownershipId: null,
      });

      if (documents.length > 0) {
        await tx.placeVerificationDocuments.createMany({
          requestId: request.id,
          documents: documents.map((d) => ({
            storageKey: d.storageKey,
            fileName: d.fileName,
            contentType: d.contentType,
            sizeBytes: d.sizeBytes,
          })),
        });
      }

      await tx.audit.log({
        entity: "place",
        entityId: input.placeId,
        action: "place.ownership_dispute_filed",
        data: {
          placeId: input.placeId,
          requestId: request.id,
          disputingOwnerType: ownerType,
          disputingOwnerId: ownerId,
          claimantHumanId: input.actorHumanId,
          reason: input.reason,
          currentVerifiedOwnershipId: verifiedOwner?.id ?? null,
        },
        at: now,
      });

      return request.id;
    });

    // Best-effort, post-commit notifications.
    await notifyAdminsOfClaim(deps, {
      placeId: input.placeId,
      placeName: place.name,
      requestId,
      source: "OWNERSHIP_DISPUTE",
    });
    // Notify the current verified owner when it's an individual human. Org-owner
    // fan-out is deferred (admins are still notified). TODO(claim-venue): notify
    // org members when the contested owner is an ORGANIZATION.
    if (verifiedOwner && verifiedOwner.ownerType === "HUMAN") {
      await notifyOwnerOfDispute(deps, {
        ownerHumanId: verifiedOwner.ownerId,
        placeId: input.placeId,
        placeName: place.name,
        requestId,
      });
    }

    return filePlaceOwnershipDisputeOutputSchema.parse({ requestId });
  };

  if (logger) {
    return logger.withTime("filePlaceOwnershipDispute", execute);
  }
  return execute();
}
