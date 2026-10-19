import { APIError } from "better-auth/api";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";

/**
 * WHO MAY SET A USER'S `image`.
 *
 * `auth_user.image` is shown to OTHER people (the ticket transfer recipient
 * search renders it), and the user hooks copy it into the profile's
 * `EntityPage.avatarUrl`. So it must hold a picture a sign-in provider
 * vouched for, never a URL a client typed: Better Auth 1.6.9 accepts
 * `image` in the body of `/update-user` and `/sign-up/email` and stores it
 * as given. An arbitrary URL there would put a tracking host, or one of our
 * own unstripped upload keys (GPS and all), on the profile, past
 * `updatePage`'s owned-copy check.
 *
 * The rule, by the endpoint the write came from (`ctx.path`, the route
 * template, as `account-security.ts` matches it):
 *   - a provider endpoint writes the image from the provider's verified
 *     profile (`mapProfileToUser`: Google's `picture`; Apple sends none);
 *   - any other endpoint may clear the image, never set it;
 *   - no endpoint (server code with no request) is trusted, as before.
 */

/**
 * Endpoints that CREATE a user from a provider profile (better-auth 1.6.9,
 * `handleOAuthUserInfo` → `createOAuthUser`). Only `/callback/:id`,
 * `/sign-in/social` (id token) and `/oauth-proxy-callback` are reachable
 * with this app's plugins; the other two are listed so enabling generic
 * OAuth or One Tap does not silently drop their pictures.
 */
export const PROVIDER_IMAGE_CREATE_PATHS: ReadonlySet<string> = new Set([
  "/callback/:id",
  "/sign-in/social",
  "/oauth-proxy-callback",
  "/oauth2/callback/:providerId",
  "/one-tap/callback",
]);

/**
 * Endpoints that UPDATE an existing user's image from a provider profile.
 * Only `/link-social` with an id token (`account.updateUserInfoOnLink`, which
 * this app turns on). Sign-in on an existing user never rewrites the image:
 * no provider sets `overrideUserInfoOnSignIn`.
 */
export const PROVIDER_IMAGE_UPDATE_PATHS: ReadonlySet<string> = new Set([
  "/link-social",
]);

/** The route template of a Better Auth hook context, if there is one. */
export function hookPath(ctx: unknown): string | undefined {
  const path = (ctx as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

/**
 * A write that SETS an image. Fails closed: Better Auth's `/update-user` body
 * is `z.record(z.string(), z.any())` and the Prisma adapter passes objects
 * through, so `{ image: { set: url } }` would store a client URL. Only an
 * absent key or an explicit clear (null / "") is NOT setting.
 */
function setsImage(data: unknown): boolean {
  if (data === null || typeof data !== "object" || !("image" in data)) return false;
  const image = (data as { image?: unknown }).image;
  return !(image === undefined || image === null || image === "");
}

/**
 * For `user.create.before`. A sign-up from a non-provider endpoint
 * (`/sign-up/email`) keeps going WITHOUT the image it sent: the returned
 * hook result overrides `image` with null. Refusing the sign-up instead
 * would turn a stray field into a failed account creation.
 */
export function dropUnverifiedImageOnCreate(
  data: unknown,
  path: string | undefined,
): { data: { image: null } } | undefined {
  if (path === undefined || PROVIDER_IMAGE_CREATE_PATHS.has(path)) return undefined;
  return setsImage(data) ? { data: { image: null } } : undefined;
}

/**
 * For `user.update.before`. Setting an image from a non-provider endpoint
 * (`/update-user`) is refused outright: no client of ours sends one, so
 * this only ever answers a hand-made request. Clearing it passes.
 */
export function refuseUnverifiedImageUpdate(
  data: unknown,
  path: string | undefined,
): void {
  if (path === undefined || PROVIDER_IMAGE_UPDATE_PATHS.has(path)) return;
  if (!setsImage(data)) return;
  throw new APIError("BAD_REQUEST", {
    message: "The profile picture cannot be set here.",
  });
}

export type ProviderAvatarSyncDeps = {
  entityPages: Pick<EntityPagesRepo, "getByOwner" | "upsert">;
  logger: LoggerPort;
  /** A failed sync is swallowed (the sign-in must not fail on it). */
  reportError?: ReporterPort;
};

/**
 * For `user.update.after`: copy a provider-set image onto the profile page.
 * Only for a provider update endpoint; `refuseUnverifiedImageUpdate` already
 * stops the others before the write, and this is the second line, so the
 * sync can never be the path an unchecked URL takes to `avatarUrl`.
 */
export async function syncProviderAvatarToPage(
  deps: ProviderAvatarSyncDeps,
  input: {
    path: string | undefined;
    humanId: string | undefined;
    image: string | null | undefined;
  },
): Promise<void> {
  const { humanId, image, path } = input;
  if (!image || !humanId) return;
  if (path === undefined || !PROVIDER_IMAGE_UPDATE_PATHS.has(path)) return;

  try {
    const page = await deps.entityPages.getByOwner("HUMAN", humanId);
    if (page && page.avatarUrl !== image) {
      await deps.entityPages.upsert({
        ownerType: "HUMAN",
        ownerId: humanId,
        slug: page.slug,
        displayName: page.displayName,
        avatarUrl: image,
      });
      deps.logger.info("auth_user_update_synced_avatar", { humanId, image });
    }
  } catch (error) {
    // Deliberate swallow, reported (CLAUDE.md "Error Reporting Convention";
    // this used to be a `warn`, which Sentry never sees). Guarded so a
    // throwing reporter cannot fail the sign-in.
    try {
      deps.reportError?.(error, {
        tags: { area: "auth", op: "provider_avatar_sync" },
        extra: { humanId },
      });
    } catch {
      // ignored on purpose
    }
    deps.logger.error("auth_user_update_avatar_sync_failed", { humanId, err: error });
  }
}
