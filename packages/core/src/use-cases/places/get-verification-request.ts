import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { z } from "zod";
import { fail } from "@th/errors";

const STAFF_REVIEWER_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

/** TTL for signed document view URLs (seconds). */
const DOC_VIEW_TTL_SECONDS = 5 * 60; // 5 minutes

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const getVerificationRequestInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Look up by request ID directly. */
    requestId: z.string().uuid().optional(),
    /** Look up the latest PENDING request for a place. */
    placeId: z.string().uuid().optional(),
  })
  .strict();

export const getVerificationRequestInputSchema =
  getVerificationRequestInputSchemaBase.refine(
    (d) => d.requestId != null || d.placeId != null,
    { message: "Either requestId or placeId is required" },
  );

const documentSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  viewUrl: z.string().url().nullable(),
  deletedAt: z.date().nullable(),
  createdAt: z.date(),
});

export const getVerificationRequestOutputSchema = z
  .object({
    id: z.string().uuid(),
    placeId: z.string().uuid(),
    // Null for HUMAN ownership claims (no org). Matches
    // PlaceVerificationRequestRecord.orgId — a non-null schema here throws in
    // .parse() when a claim request is resolved by placeId.
    orgId: z.string().uuid().nullable(),
    // Null when the submitting account has been deleted (submitter detached).
    // Matches PlaceVerificationRequestRecord.submittedById — a non-null schema
    // here throws in .parse() for requests whose submitter deleted themselves.
    submittedById: z.string().uuid().nullable(),
    status: z.enum([
      "PENDING",
      "IN_REVIEW",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
    ]),
    // Claim-venue provenance carried on PlaceVerificationRequestRecord. The
    // output spreads `...request`, so a .strict() schema MUST list these or
    // .parse() throws "Unrecognized keys" for any claim/dispute request.
    source: z.enum(["ORG_SUBMISSION", "OWNERSHIP_CLAIM", "OWNERSHIP_DISPUTE"]),
    claimantHumanId: z.string().uuid().nullable(),
    claimOwnerType: z.enum(["HUMAN", "ORGANIZATION"]).nullable(),
    claimOwnerId: z.string().uuid().nullable(),
    ownershipId: z.string().uuid().nullable(),
    reviewerNotes: z.string().nullable(),
    reviewerHumanId: z.string().uuid().nullable(),
    reviewedAt: z.date().nullable(),
    acknowledgedAt: z.date().nullable(),
    acknowledgedBy: z.string().uuid().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    documents: z.array(documentSchema),
  })
  .strict();

export type GetVerificationRequestInput = z.infer<
  typeof getVerificationRequestInputSchema
>;
export type GetVerificationRequestOutput = z.infer<
  typeof getVerificationRequestOutputSchema
>;

export type GetVerificationRequestDeps = {
  repos: Pick<
    Repos,
    "placeVerificationRequests" | "placeVerificationDocuments"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  storage: FileStoragePort;
  logger?: LoggerPort;
};

/**
 * Retrieves a verification request with its documents and signed view URLs.
 *
 * Gated by hasStaffRole(["ADMIN", "REVIEWER"]).
 * Documents that have been deleted get `viewUrl: null`.
 */
export async function getVerificationRequest(
  deps: GetVerificationRequestDeps,
  rawInput: unknown,
): Promise<GetVerificationRequestOutput> {
  const logger = deps.logger?.child({ useCase: "getVerificationRequest" });

  const execute = async () => {
    const input = parseInput(getVerificationRequestInputSchema, rawInput);

    // Staff gate
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...STAFF_REVIEWER_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }

    const request = input.requestId
      ? await deps.repos.placeVerificationRequests.getById(input.requestId)
      : await deps.repos.placeVerificationRequests.getLatestForPlace(
          input.placeId!,
        );
    if (!request) {
      throw fail("VERIFICATION_REQUEST_NOT_FOUND");
    }

    const documents =
      await deps.repos.placeVerificationDocuments.listByRequestId(request.id);

    // Generate signed view URLs for non-deleted documents
    const docsWithUrls = await Promise.all(
      documents.map(async (doc) => {
        let viewUrl: string | null = null;
        if (!doc.deletedAt) {
          try {
            const result = await deps.storage.getObjectUrl({
              key: doc.storageKey,
              options: { expiresSec: DOC_VIEW_TTL_SECONDS },
            });
            viewUrl = result.url;
          } catch (err) {
            logger?.warn("signed_url_failed", {
              documentId: doc.id,
              storageKey: doc.storageKey,
              error: String(err),
            });
          }
        }
        return {
          id: doc.id,
          fileName: doc.fileName,
          contentType: doc.contentType,
          sizeBytes: doc.sizeBytes,
          viewUrl,
          deletedAt: doc.deletedAt,
          createdAt: doc.createdAt,
        };
      }),
    );

    return getVerificationRequestOutputSchema.parse({
      ...request,
      documents: docsWithUrls,
    });
  };

  if (logger) {
    return logger.withTime("getVerificationRequest", execute);
  }

  return execute();
}
