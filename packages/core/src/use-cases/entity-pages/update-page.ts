import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { ClockPort } from "@th/ports/clock";
import {
  isFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import {
  markForSearchReindex,
  type SearchReindexSelector,
} from "../search/search-reindex-marks";
import { fail } from "@th/errors";
import {
  plainTextMultilineOptional,
  plainTextOptional,
} from "../../lib/sanitize-plain-text";
import { strippedCopyKeyFromUrl } from "../profiles/storage-url";
import { getEntityPageImageKeyPrefix } from "./page-image-upload-helpers";
import {
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  resolveEntityPageEditor,
} from "./entity-page-access";

// ── Schemas ────────────────────────────────────────────────────────────────

const pageOwnerTypeSchema = z.enum(["HUMAN", "ORGANIZATION", "PLACE"]);

export const updatePageInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    ownerType: pageOwnerTypeSchema,
    ownerId: z.string().min(1),
    slug: z.string().trim().min(1).max(200).optional(),
    displayName: plainTextOptional(200).nullable().optional(),
    bio: plainTextMultilineOptional(2000).nullable().optional(),
    // Only a stripped copy this owner published (checked in the use case,
    // which knows the owner and the page's current value).
    avatarUrl: z.string().url().max(2048).nullable().optional(),
    bannerUrl: z.string().url().max(2048).nullable().optional(),
    visibility: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]).optional(),
  })
  .strict();

export const updatePageOutputSchema = z
  .object({
    page: z.object({
      id: z.string(),
      ownerType: pageOwnerTypeSchema,
      ownerId: z.string(),
      slug: z.string(),
      displayName: z.string().nullable(),
      bio: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      bannerUrl: z.string().nullable(),
      visibility: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
  })
  .strict();

export type UpdatePageInput = z.infer<typeof updatePageInputSchema>;
export type UpdatePageOutput = z.infer<typeof updatePageOutputSchema>;

// ── Deps ───────────────────────────────────────────────────────────────────

export type UpdatePageDeps = {
  repos: Repos;
  authz: AuthZPort;
  /**
   * Required (FR-003) — forwarded to the post-write reindex, which resolves
   * every tier's effective price at index time (FR-008).
   */
  clock: ClockPort;
  /**
   * Resolves a candidate avatar/banner key to its public URL, so a new
   * image URL is accepted only when it is exactly the storage's own URL for
   * a stripped copy under the owner's prefix ({@link assertOwnedImageUrl}).
   */
  storage: Pick<FileStoragePort, "getObjectUrl">;
  logger?: LoggerPort;
  /**
   * Optional search port. When provided, the just-updated entity is
   * incrementally upserted into the search index so name/bio changes
   * appear without waiting for the nightly reindex.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort reporter, forwarded to the post-write reindex. Load-bearing
   * here specifically: this use case is what flips `visibility`, and the
   * reindex it kicks off is what STRIPS a now-UNLISTED/PRIVATE page's slug out
   * of the search index. If that reindex's EntityPage read fails it is
   * swallowed, the stale slug survives, and without this nothing says so.
   */
  reportError?: ReporterPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function updatePage(
  deps: UpdatePageDeps,
  rawInput: unknown,
): Promise<UpdatePageOutput> {
  const logger = deps.logger?.child({ useCase: "updatePage" });

  const execute = async (): Promise<UpdatePageOutput> => {
    const input = parseInput(updatePageInputSchema, rawInput);

    const editor = await resolveEntityPageEditor(deps, input);
    // A place has ONE name, Place.name (owner ruling); a moderator changes
    // place facts through updateCommunityPlace, never the page's
    // displayName. The owner path is unchanged.
    if (
      editor.kind === "community_moderator" &&
      input.displayName !== undefined
    ) {
      throw fail("INVALID_INPUT", { meta: { field: "displayName" } });
    }

    const existing = await deps.repos.entityPages.getByOwner(
      input.ownerType,
      input.ownerId,
    );
    if (!existing) {
      throw fail("PAGE_NOT_FOUND");
    }

    await assertOwnedImageUrl(deps, input, existing, "avatarUrl");
    await assertOwnedImageUrl(deps, input, existing, "bannerUrl");

    // The page's owner document shows its name, bio, slug and visibility.
    const selector: SearchReindexSelector = {
      kind:
        input.ownerType === "HUMAN"
          ? "human"
          : input.ownerType === "ORGANIZATION"
            ? "organization"
            : "place",
      id: input.ownerId,
    };

    // One transaction: slug history, the page write and the search mark
    // (and, for a community moderator, the claim-lock re-check and audit).
    const page = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();
      await recheckCommunityPageEditor(tx, editor, now);
      // The fields this call does not set, the slug comparison and the slug
      // history come from the row read INSIDE the transaction: a write that
      // committed after the read above (two moderators queued on the claim
      // lock, say) keeps its fields instead of being reverted.
      const current =
        (await tx.entityPages.getByOwner(input.ownerType, input.ownerId)) ??
        existing;
      // assertOwnedImageUrl (above, outside the transaction: it HEADs the
      // storage) let an image URL through unchecked when it equalled the
      // pre-transaction row. If the in-tx row no longer holds it, that URL
      // was replaced meanwhile (its copy may be deleted and credited back),
      // so re-sending it is a NEW value nobody verified: refused.
      for (const field of ["avatarUrl", "bannerUrl"] as const) {
        const value = input[field];
        if (
          value !== undefined &&
          value !== null &&
          value === existing[field] &&
          value !== current[field]
        ) {
          throw fail("INVALID_INPUT", { meta: { field } });
        }
      }

      // If slug is changing, validate availability and record history.
      const newSlug = input.slug ?? current.slug;
      if (newSlug !== current.slug) {
        const available = await tx.entityPages.isSlugAvailable(
          newSlug,
          current.id,
        );
        if (!available) {
          throw fail("SLUG_TAKEN");
        }
        // Record the old slug in history so old URLs redirect.
        await tx.entityPages.recordSlugHistory(current.id, current.slug);
      }

      const written = await tx.entityPages.upsert({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        slug: newSlug,
        displayName:
          input.displayName !== undefined
            ? input.displayName
            : current.displayName,
        bio: input.bio !== undefined ? input.bio : current.bio,
        avatarUrl:
          input.avatarUrl !== undefined ? input.avatarUrl : current.avatarUrl,
        bannerUrl:
          input.bannerUrl !== undefined ? input.bannerUrl : current.bannerUrl,
        visibility: input.visibility ?? current.visibility,
      });
      await markForSearchReindex(tx, [selector], deps.clock.now());
      const changes = pageFieldChanges(current, written);
      await logCommunityPageUpdate(
        tx,
        editor,
        {
          actorHumanId: input.actorHumanId,
          pageId: written.id,
          op: "updatePage",
          fields: Object.keys(changes.to),
          ...changes,
        },
        now,
      );
      return written;
    });

    reindexAfterMutation(
      {
        repos: deps.repos,
        search: deps.search,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      "updatePage",
      selector,
    );

    return updatePageOutputSchema.parse({ page });
  };

  if (logger) {
    return logger.withTime("updatePage", execute);
  }
  return execute();
}

// ── Image URL guard ────────────────────────────────────────────────────────

/**
 * A NEW avatar/banner URL must name an EXISTING METADATA-STRIPPED COPY of
 * the page's own image uploads (`entity-pages/<type>/<id>/`), at the
 * storage's public origin; anything else, a copy that is gone included, is
 * `INVALID_INPUT` with `meta.field`. Clearing (null) and re-sending the
 * current value always pass, so a page that predates this check keeps
 * whatever it shows.
 *
 * Why the URL cannot be free-form:
 *   - an upload key (`<prefix><day>/<uuid>.<ext>`) holds the ORIGINAL, GPS
 *     and all. A client that skipped the finalize and stored it would keep it
 *     public forever: nothing claims or deletes an unfinalized upload's key
 *     except the finalize.
 *   - a replaced avatar/banner is deleted and its size credited back to the
 *     quota (`cleanup-replaced-image.ts`). Pointing the profile at an upload
 *     re-PUT through its still-valid presigned URL, then replacing it, would
 *     credit bytes nobody was charged for: unbounded storage past the quota.
 *
 *   - a copy under the PROFILE prefixes (`avatars|banners/human/<id>/`) is
 *     the one kind of URL whose replacement credits quota back. A copy a
 *     losing finalize wrote (never charged, outboxed, not yet drained)
 *     lives there too; pointing the profile at it and replacing it would
 *     credit it. Only the profile finalizes may set those.
 *
 * The one prefix is what the clients send (inventory, 2026-10-08): the page
 * editor (`PageFieldsEditor`) sets avatar/banner from `entityPages.
 * finalizeImageUpload`, a copy under `entity-pages/<type>/<id>/` for every
 * owner type; the profile finalizes (`setAvatarFromUpload` /
 * `setBannerFromUpload`) write the page themselves, not through here. The
 * OAuth avatar sync stores the provider's URL through the repo; a page
 * holding one keeps it here as the unchanged value.
 *
 * The storage's `getObjectUrl` HEADs the object, so the copy must exist:
 * its `not_found` is this refusal too, not a storage error.
 */
async function assertOwnedImageUrl(
  deps: Pick<UpdatePageDeps, "storage">,
  input: UpdatePageInput,
  existing: { avatarUrl: string | null; bannerUrl: string | null },
  field: "avatarUrl" | "bannerUrl",
): Promise<void> {
  const value = input[field];
  if (value === undefined || value === null || value === existing[field]) {
    return;
  }

  const key = strippedCopyKeyFromUrl(value, [
    getEntityPageImageKeyPrefix(input.ownerType, input.ownerId),
  ]);
  if (key) {
    let url: string;
    try {
      ({ url } = await deps.storage.getObjectUrl({
        key,
        options: { public: true },
      }));
    } catch (err) {
      if (isFileStorageError(err) && err.code === "not_found") {
        throw fail("INVALID_INPUT", { meta: { field } });
      }
      throw err;
    }
    if (url === value) return;
  }
  throw fail("INVALID_INPUT", { meta: { field } });
}

// ── Audit helper ───────────────────────────────────────────────────────────

const AUDITED_PAGE_FIELDS = [
  "slug",
  "displayName",
  "bio",
  "avatarUrl",
  "bannerUrl",
  "visibility",
] as const;

type AuditedPageFields = {
  [K in (typeof AUDITED_PAGE_FIELDS)[number]]: string | null;
};

/** The page fields this write changed: before (`from`) and after (`to`). */
function pageFieldChanges(
  before: AuditedPageFields,
  after: AuditedPageFields,
): { from: Partial<AuditedPageFields>; to: Partial<AuditedPageFields> } {
  const from: Partial<AuditedPageFields> = {};
  const to: Partial<AuditedPageFields> = {};
  for (const field of AUDITED_PAGE_FIELDS) {
    if (before[field] !== after[field]) {
      from[field] = before[field];
      to[field] = after[field];
    }
  }
  return { from, to };
}
