import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const STAFF_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];
const URL_TTL_SECONDS = 15 * 60;

export const getVerificationDocumentUrlInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    documentId: z.string().uuid(),
  })
  .strict();

export const getVerificationDocumentUrlOutputSchema = z
  .object({
    url: z.string().url(),
    expiresAt: z.date(),
  })
  .strict();

export type GetVerificationDocumentUrlInput = z.infer<
  typeof getVerificationDocumentUrlInputSchema
>;
export type GetVerificationDocumentUrlOutput = z.infer<
  typeof getVerificationDocumentUrlOutputSchema
>;

export type GetVerificationDocumentUrlDeps = {
  repos: Pick<
    Repos,
    "placeVerificationDocuments" | "placeVerificationRequests"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Returns a 15-minute presigned GET URL for a single verification document.
 *
 * Authorized callers:
 * - Platform staff (ADMIN / REVIEWER) — for the review workbench.
 * - The original submitter — so organizers can re-download what they uploaded.
 *
 * NOTE: org co-admins of the submitting org are NOT currently authorized
 * here. The submitted-files-are-private guarantee leans toward only the
 * person who actually uploaded a file being able to refetch it; widen this
 * if you discover the spec wants org-wide access.
 */
export async function getVerificationDocumentUrl(
  deps: GetVerificationDocumentUrlDeps,
  rawInput: unknown,
): Promise<GetVerificationDocumentUrlOutput> {
  const input = parseInput(getVerificationDocumentUrlInputSchema, rawInput);

  const document = await deps.repos.placeVerificationDocuments.getById(
    input.documentId,
  );
  if (!document) {
    throw fail("DOCUMENT_NOT_FOUND");
  }
  if (document.deletedAt) {
    throw fail("DOCUMENT_DELETED");
  }

  const request = await deps.repos.placeVerificationRequests.getById(
    document.requestId,
  );
  if (!request) {
    // Orphan document — treat as not found rather than leaking storage URLs.
    throw fail("VERIFICATION_REQUEST_NOT_FOUND");
  }

  const isSubmitter = request.submittedById === input.actorHumanId;
  let isStaff = false;
  if (!isSubmitter) {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...STAFF_ROLES],
    });
    isStaff = staff.allowed;
  }
  if (!isSubmitter && !isStaff) {
    throw fail("NOT_AUTHORIZED");
  }

  const result = await deps.storage.getObjectUrl({
    key: document.storageKey,
    options: { expiresSec: URL_TTL_SECONDS },
  });

  const expiresAt = new Date(
    deps.clock.now().getTime() + URL_TTL_SECONDS * 1000,
  );

  deps.logger?.info("places.get_verification_document_url", {
    documentId: document.id,
    requestId: document.requestId,
    actorHumanId: input.actorHumanId,
    via: isStaff ? "staff" : "submitter",
  });

  return getVerificationDocumentUrlOutputSchema.parse({
    url: result.url,
    expiresAt,
  });
}
