import { z } from "zod";

import type {
  ResourceLimitKind,
  QuotaSubjectType,
} from "@th/ports/repos/resource-quotas";
import type { PageOwnerType } from "@th/types/repos/entity-pages";

import type { EntityPageOwnerInput } from "./entity-page-access";

export const ENTITY_PAGE_OWNER_TYPES = [
  "HUMAN",
  "ORGANIZATION",
  "PLACE",
] as const satisfies readonly PageOwnerType[];

export const ENTITY_PAGE_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export const MAX_ENTITY_PAGE_IMAGE_BYTES = 25 * 1024 * 1024;

export const entityPageOwnerTypeSchema = z.enum(ENTITY_PAGE_OWNER_TYPES);
export const entityPageImageContentTypeSchema = z.enum(
  ENTITY_PAGE_IMAGE_CONTENT_TYPES,
);
export const entityPageImageOwnerIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export type EntityPageImageContentType =
  (typeof ENTITY_PAGE_IMAGE_CONTENT_TYPES)[number];
export type EntityPageImageOwnerType = z.infer<
  typeof entityPageOwnerTypeSchema
>;

export const entityPageImageContentTypeToExtension: Record<
  EntityPageImageContentType,
  string
> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

// The page access check lives in entity-page-access.ts (FR-003: one PLACE
// page check).

/**
 * The quota a page image upload is charged to (and credited back to):
 *   - an ORGANIZATION page: the org;
 *   - a community moderator's upload to an unowned PLACE page
 *     (`communityUpload`): the PLACE itself, STORAGE_BYTES_PLACE. The place
 *     holds those images until someone claims it, so the moderator's own
 *     quota is never charged (moderator place page spec R5); nothing moves
 *     to the claimant's quota at claim;
 *   - anything else (a HUMAN page, a place OWNER's upload): the actor.
 *
 * The request decides `communityUpload` from the editor and pins it in the
 * request's outbox row (`PAGE_IMAGE_COMMUNITY_REQUEST_SOURCE` in
 * request-page-image-upload.ts); the finalize reads the row back, even if
 * the actor's editor kind changed in between. A community upload is only
 * CHECKED against the place's quota at request and CHARGED (the stripped
 * copy's size) at finalize; every other upload is charged its declared size
 * at request and credited the strip's savings at finalize.
 */
export function getEntityPageImageQuotaSubject(
  input: EntityPageOwnerInput,
  options: { communityUpload?: boolean } = {},
): {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
} {
  if (input.ownerType === "ORGANIZATION") {
    return {
      subjectType: "ORG",
      subjectId: input.ownerId,
      kind: "STORAGE_BYTES_ORG",
    };
  }

  if (input.ownerType === "PLACE" && options.communityUpload === true) {
    return {
      subjectType: "PLACE",
      subjectId: input.ownerId,
      kind: "STORAGE_BYTES_PLACE",
    };
  }

  return {
    subjectType: "HUMAN",
    subjectId: input.actorHumanId,
    kind: "STORAGE_BYTES_HUMAN",
  };
}

export function getEntityPageImageKeyPrefix(
  ownerType: EntityPageImageOwnerType,
  ownerId: string,
): string {
  return `entity-pages/${ownerType.toLowerCase()}/${ownerId}/`;
}

/**
 * The presigned PUT's metadata key naming the human who requested the
 * upload. Signed into the URL, so the uploader cannot change it; the
 * finalize refuses an upload stamped with a different human (see
 * `prepareStrippedUpload`'s `uploader`).
 */
export const ENTITY_PAGE_IMAGE_UPLOADER_METADATA_KEY = "th-actor-human-id";

export function buildEntityPageImageMetadata(
  input: EntityPageOwnerInput,
): Record<string, string> {
  return {
    "th-kind": "entity-page-image",
    "th-owner-type": input.ownerType,
    "th-owner-id": input.ownerId,
    [ENTITY_PAGE_IMAGE_UPLOADER_METADATA_KEY]: input.actorHumanId,
  };
}
