import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getPublicPage,
  getPublicPageInputSchema,
  getPublicPageOutputSchema,
  checkSlugAvailability,
  checkSlugAvailabilityInputSchema,
  checkSlugAvailabilityOutputSchema,
  getMyPage,
  getMyPageInputSchema,
  getMyPageOutputSchema,
  updatePage,
  updatePageInputSchema,
  updatePageOutputSchema,
  updatePageTheme,
  updatePageThemeInputSchema,
  updatePageThemeOutputSchema,
  requestPageImageUpload,
  requestPageImageUploadInputSchema,
  requestPageImageUploadOutputSchema,
  finalizePageImageUpload,
  finalizePageImageUploadInputSchema,
  finalizePageImageUploadOutputSchema,
  managePageBlocks,
  managePageBlocksInputSchema,
  managePageBlocksOutputSchema,
  getPlacePageEditAccess,
  getPlacePageEditAccessInputSchema,
  getPlacePageEditAccessOutputSchema,
  getCommunityHandover,
  getCommunityHandoverInputSchema,
  getCommunityHandoverOutputSchema,
} from "@th/core/use-cases/entity-pages";
// Server-only (imports page-draft-ops), so by subpath, not the barrel.
import {
  resolveCommunityHandover,
  resolveCommunityHandoverInputSchema,
  resolveCommunityHandoverOutputSchema,
} from "@th/core/use-cases/entity-pages/resolve-community-handover";

import {
  getMyProfile,
  getMyProfileOutputSchema,
  requestAvatarUpload,
  requestAvatarUploadInputSchema,
  requestAvatarUploadOutputSchema,
  requestBannerUpload,
  requestBannerUploadInputSchema,
  requestBannerUploadOutputSchema,
  setAvatarFromUpload,
  setAvatarFromUploadInputSchema,
  setAvatarFromUploadOutputSchema,
  setBannerFromUpload,
  setBannerFromUploadInputSchema,
  setBannerFromUploadOutputSchema,
} from "@th/core/use-cases/profiles";

import { getFeatureGates } from "@th/core/use-cases/features";

import { rateLimit } from "../guard";
import { publicProcedure, authedProcedure } from "../init";
import type { Ctx } from "../context";
import { toTrpcError } from "../utils";

/**
 * Server-side enforcement of the `entityPageEditor` feature gate for the
 * freeform block-editor WRITE path (`managePageBlocks`). The editor canvas is
 * hidden client-side when the gate is off (`PageEditorView`), but the mutation
 * was previously a plain `authedProcedure` with no gate — a technical user
 * could call it directly and bypass the unlock. This closes that hole.
 *
 * The gate is resolved the SAME way the features router / `getFeatureGates`
 * resolves it — DB override (`feature:entityPageEditor`) ?? env
 * `ENABLE_ENTITY_PAGE_EDITOR` (`ctx.enableEntityPageEditor`) ?? false — so
 * flipping the platform setting unlocks the API in lockstep with the client.
 * Fail-closed: a settings-read failure falls back to the env default (off
 * unless explicitly enabled).
 *
 * Only `managePageBlocks` is gated, and only PER-ACTION: structural changes
 * (`add`, `delete`, `reorder`, and `edit`s that change a block's `kind`)
 * require the gate; content `edit`s (data/visible only) and
 * `toggleVisibility` on existing (template-seeded) blocks are always allowed.
 * Rendering (`getBySlug`), standard-template edits (`updatePage`,
 * `updatePageTheme`, `getMyPage`), and image uploads are deliberately NOT
 * gated — standard templates and seeded block content must keep working while
 * the freeform editor stays locked. Access control (`resolveEntityPageEditor`
 * inside the use case) still applies to EVERY action regardless of the gate.
 */
const GATED_BLOCK_ACTIONS = ["add", "delete", "reorder"] as const;

/**
 * Pure gating decision: structural block actions (add/delete/reorder) require
 * the `entityPageEditor` gate; content edits and visibility toggles on
 * existing blocks do not. An `edit` that carries a `kind` is ALSO gated — the
 * core edit path validates and persists `kind`, so a kind-bearing edit would
 * transmute a seeded block into a different block type ("add" by
 * replacement). Plain data/visible edits stay ungated. Exported for unit
 * tests.
 */
export function isBlockActionGated(blockAction: {
  action: string;
  kind?: unknown;
}): boolean {
  if ((GATED_BLOCK_ACTIONS as readonly string[]).includes(blockAction.action)) {
    return true;
  }
  return blockAction.action === "edit" && blockAction.kind !== undefined;
}

async function ensureBlockActionAllowed(
  ctx: Ctx,
  blockAction: { action: string; kind?: unknown },
): Promise<void> {
  // Content edits and visibility toggles on template-seeded blocks are always
  // allowed; structural changes (add/delete/reorder, and kind-changing edits)
  // stay behind the entityPageEditor gate.
  if (!isBlockActionGated(blockAction)) {
    return;
  }
  const gates = await getFeatureGates({
    enableEntityPageEditor: ctx.enableEntityPageEditor,
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  if (!gates.entityPageEditor) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "The page block editor is not enabled.",
    });
  }
}

// Omit actorHumanId from authed inputs — it's injected from the session.
const getMyPageInput = getMyPageInputSchema.omit({ actorHumanId: true });
const updatePageInput = updatePageInputSchema.omit({ actorHumanId: true });
const updatePageThemeInput = updatePageThemeInputSchema.omit({
  actorHumanId: true,
});
const managePageBlocksInput = managePageBlocksInputSchema.omit({
  actorHumanId: true,
});
const requestPageImageUploadInput = requestPageImageUploadInputSchema.omit({
  actorHumanId: true,
});
const finalizePageImageUploadInput = finalizePageImageUploadInputSchema.omit({
  actorHumanId: true,
});
const requestAvatarUploadInput = requestAvatarUploadInputSchema.omit({
  actorHumanId: true,
});
const setAvatarFromUploadInput = setAvatarFromUploadInputSchema.omit({
  actorHumanId: true,
});
const requestBannerUploadInput = requestBannerUploadInputSchema.omit({
  actorHumanId: true,
});
const setBannerFromUploadInput = setBannerFromUploadInputSchema.omit({
  actorHumanId: true,
});
const placePageEditAccessInput = getPlacePageEditAccessInputSchema.omit({
  actorHumanId: true,
});
const communityHandoverInput = getCommunityHandoverInputSchema.omit({
  actorHumanId: true,
});
const resolveCommunityHandoverInput = resolveCommunityHandoverInputSchema.omit(
  { actorHumanId: true },
);

const addActor = <T extends Record<string, unknown>>(
  input: T,
  actorHumanId: string,
) => ({
  ...input,
  actorHumanId,
});

/**
 * Per actor, ONE bucket for every finalize that runs the image metadata
 * strip: page images, avatar, banner here, and `events.finalizeImageUpload`
 * (events.ts uses the same key string). Each call may read, strip and
 * rewrite an upload of up to 25 MB through a process-wide pool of strip
 * slots, so separate buckets would let one account fill that pool four
 * times over and make every other user's finalize fail `image_strip_busy`.
 * 20/min leaves room for dropping a handful of images into an editor.
 */
const imageFinalizeRateLimit = () =>
  rateLimit({
    key: (ctx) => `images:finalize:${ctx.actorHumanId}`,
    maxRequests: 20,
    windowSeconds: 60,
    message: "finalizing image uploads",
  });

/**
 * Per actor, ONE bucket for every upload request. Each one mints a presigned
 * URL and writes an `upload-request` row to the deletion outbox, so one
 * account could otherwise flood that outbox. Shared with
 * `events.requestImageUpload` (events.ts uses the same key string).
 */
const imageRequestRateLimit = () =>
  rateLimit({
    key: (ctx) => `images:request:${ctx.actorHumanId}`,
    maxRequests: 20,
    windowSeconds: 60,
    message: "requesting image uploads",
  });

export const entityPagesRouter = {
  /** Public: fetch a page by slug (respects visibility). */
  getBySlug: publicProcedure
    .input(getPublicPageInputSchema)
    .output(getPublicPageOutputSchema)
    .query(async ({ ctx, input }) => {
      let result;
      try {
        result = await getPublicPage(
          {
            repos: ctx.repos,
            logger: ctx.logger,
            // Corrupt venue_stats snapshots are swallowed (block renders
            // nothing) — report them per the Sentry convention.
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }

      // Data-layer enforcement of the `humanProfilesPublic` gate. The render
      // routes (`/humans/[slug]`, `/p/[slug]`) 404 HUMAN pages when the gate is
      // off, but this public procedure is directly callable — without this
      // check an unauthenticated `entityPages.getBySlug({slug})` would leak a
      // hidden human's full profile (displayName, bio, avatar/banner, blocks,
      // stats). Resolve the gate the SAME way `ensureBlockActionAllowed` and
      // the search router do (DB override ?? env `ENABLE_HUMAN_PROFILES_PUBLIC`
      // ?? false), fail-CLOSED: a settings-read failure yields the env default
      // (off) → hidden. ORG/PLACE are never gated; owner reads use `getMyPage`.
      if (result.entity.type === "HUMAN") {
        const gates = await getFeatureGates({
          enableHumanProfilesPublic: ctx.enableHumanProfilesPublic,
          platformSettings: ctx.repos.platformSettings,
          reportError: ctx.reportError ?? undefined,
        });
        if (!gates.humanProfilesPublic) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
      }

      return result;
    }),

  /** Authed: check if a slug is available for use. */
  isSlugAvailable: authedProcedure
    .input(checkSlugAvailabilityInputSchema)
    .output(checkSlugAvailabilityOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await checkSlugAvailability(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: fetch own page (includes hidden blocks). */
  getMyPage: authedProcedure
    .input(getMyPageInput)
    .output(getMyPageOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        // Surfaces the swallowed lazy template-seed failure to Sentry.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getMyPage>[0];

      try {
        return await getMyPage(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: update page fields (slug, displayName, bio, etc.). */
  updatePage: authedProcedure
    .input(updatePageInput)
    .output(updatePageOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        authz: ctx.authz,
        storage: ctx.fileStorage,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof updatePage>[0];

      try {
        return await updatePage(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: update page theme (colors, font, layout). */
  updatePageTheme: authedProcedure
    .input(updatePageThemeInput)
    .output(updatePageThemeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updatePageTheme>[0];

      try {
        return await updatePageTheme(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: add, edit, reorder, toggle visibility, or delete blocks. */
  managePageBlocks: authedProcedure
    .input(managePageBlocksInput)
    .output(managePageBlocksOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // Gate structural block writes (add/delete/reorder and kind-changing
      // edits) BEFORE any block writes; data/visible edits and
      // toggleVisibility pass regardless of the gate.
      await ensureBlockActionAllowed(ctx, input.blockAction);

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        // The block image-URL rule (own stripped upload, or already live).
        storagePublicBaseUrl: ctx.storagePublicBaseUrl ?? null,
      } satisfies Parameters<typeof managePageBlocks>[0];

      try {
        return await managePageBlocks(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: get a presigned URL to upload a page-owned image. */
  requestImageUpload: authedProcedure
    .input(requestPageImageUploadInput)
    .use(imageRequestRateLimit())
    .output(requestPageImageUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof requestPageImageUpload>[0];

      try {
        return await requestPageImageUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: confirm a page-owned image upload and resolve its public URL. */
  finalizeImageUpload: authedProcedure
    .input(finalizePageImageUploadInput)
    .use(imageFinalizeRateLimit())
    .output(finalizePageImageUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof finalizePageImageUpload>[0];

      try {
        return await finalizePageImageUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─── Moderator place page (spec 2026-10-14, FR-005..FR-007) ────────────────

  /**
   * Authed: may the caller edit this PLACE's page, as owner or community
   * moderator, and if not why (advisory; writes nothing).
   */
  placePageEditAccess: authedProcedure
    .input(placePageEditAccessInput)
    .output(getPlacePageEditAccessOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof getPlacePageEditAccess>[0];

      try {
        return await getPlacePageEditAccess(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Authed, place OWNER only: the moderator writes on the page the owner has
   * not yet kept or cleared (`pending: null` when none).
   */
  communityHandover: authedProcedure
    .input(communityHandoverInput)
    .output(getCommunityHandoverOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getCommunityHandover>[0];

      try {
        return await getCommunityHandover(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Authed, place OWNER only: "keep" or "clear" what the moderators wrote.
   * Clear empties bio, avatar and banner, resets the MAIN-section blocks to
   * the place template and the theme to its defaults, in one transaction;
   * it refuses (INVALID_INPUT, "handover_draft_pending") while the page
   * draft holds edits.
   */
  resolveCommunityHandover: authedProcedure
    .input(resolveCommunityHandoverInput)
    .output(resolveCommunityHandoverOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        storagePublicBaseUrl: ctx.storagePublicBaseUrl ?? null,
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof resolveCommunityHandover>[0];

      try {
        return await resolveCommunityHandover(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─── Profile convenience endpoints (migrated from profilesRouter) ──────────

  /** Authed: lightweight profile summary for the current user. */
  getMyProfile: authedProcedure
    .input(z.object({}).strict())
    .output(getMyProfileOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await getMyProfile(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: get a presigned URL to upload a new avatar image. */
  requestAvatarUpload: authedProcedure
    .input(requestAvatarUploadInput)
    .use(imageRequestRateLimit())
    .output(requestAvatarUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await requestAvatarUpload(
          {
            repos: ctx.repos,
            storage: ctx.fileStorage,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          addActor(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: confirm avatar upload and persist the new URL. */
  setAvatarFromUpload: authedProcedure
    .input(setAvatarFromUploadInput)
    .use(imageFinalizeRateLimit())
    .output(setAvatarFromUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await setAvatarFromUpload(
          {
            repos: ctx.repos,
            storage: ctx.fileStorage,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          addActor(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: get a presigned URL to upload a new banner image. */
  requestBannerUpload: authedProcedure
    .input(requestBannerUploadInput)
    .use(imageRequestRateLimit())
    .output(requestBannerUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await requestBannerUpload(
          {
            repos: ctx.repos,
            storage: ctx.fileStorage,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          addActor(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Authed: confirm banner upload and persist the new URL. */
  setBannerFromUpload: authedProcedure
    .input(setBannerFromUploadInput)
    .use(imageFinalizeRateLimit())
    .output(setBannerFromUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await setBannerFromUpload(
          {
            repos: ctx.repos,
            storage: ctx.fileStorage,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          addActor(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
