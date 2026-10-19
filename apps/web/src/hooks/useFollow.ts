"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotify, useTranslations } from "@th/ui";
import { usePathname } from "next/navigation";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";

export interface UseFollowResult {
  /** Whether the viewer currently follows the entity (optimistic). */
  isFollowing: boolean;
  /**
   * Public follower count, or `null` when the entity page hides its count.
   * Optimistically nudged by the viewer's own toggle while in flight.
   */
  followerCount: number | null;
  /** A follow/unfollow mutation is in flight. */
  isPending: boolean;
  /** The follow action is wired for this entity page. */
  canFollow: boolean;
  /** Toggle follow state; opens the sign-in overlay for signed-out viewers. */
  toggle: () => void;
}

/**
 * Follow/unfollow state for one entity page (HUMAN / ORG / PLACE).
 *
 * - `getFollowerCount` is PUBLIC and always fires (the count may be hidden →
 *   `null`).
 * - `isFollowing` is AUTHED and only fires once the session resolves to a
 *   signed-in user.
 * - `toggle()` optimistically flips the follow flag (and nudges the visible
 *   count) with rollback on error. Signed-out viewers get the in-place
 *   sign-in overlay (`showSignInOverlay`, redirect = current page — same
 *   pattern as the booking CTAs / checkout / saved) instead of mutating; an
 *   UNAUTHORIZED bounce mid-flight opens it too. Every `useFollow` consumer
 *   (hero FollowButton, venue/entity hero menus) renders under the global
 *   `AppOverlayProvider` mounted in providers.tsx, so `useAppOverlay` is
 *   always available here; on narrow viewports the provider itself falls
 *   back to the standalone /sign-in page.
 */
export function useFollow(entityPageId: string): UseFollowResult {
  const pathname = usePathname();
  const { toast } = useNotify();
  const t = useTranslations();
  const { showSignInOverlay } = useAppOverlay();
  const utils = trpc.useUtils();

  const { data: session } = authClient.useSession();
  const signedIn = Boolean(session?.user);

  const hasEntity = Boolean(entityPageId);

  const followerCountQuery = trpc.follows.getFollowerCount.useQuery(
    { entityPageId },
    { enabled: hasEntity, retry: false, staleTime: 30_000 },
  );

  const isFollowingQuery = trpc.follows.isFollowing.useQuery(
    { entityPageId },
    {
      enabled: signedIn && hasEntity,
      retry: false,
      staleTime: 30_000,
    },
  );

  const serverIsFollowing = isFollowingQuery.data?.isFollowing ?? false;

  // Transient optimistic override: null means "defer to server". Reconciled
  // away once the server agrees, so a stale flip never shadows newer truth.
  const [override, setOverride] = useState<boolean | null>(null);

  useEffect(() => {
    if (override !== null && serverIsFollowing === override) {
      setOverride(null);
    }
  }, [override, serverIsFollowing]);

  const isFollowing = override ?? serverIsFollowing;

  const followMutation = trpc.follows.followEntity.useMutation();
  const unfollowMutation = trpc.follows.unfollowEntity.useMutation();
  const isPending = followMutation.isPending || unfollowMutation.isPending;

  // Respect the page's follower-count visibility: the API returns `count: 0`
  // (not null) with `isPublic: false` when the page hides its count, so gate on
  // `isPublic` — otherwise a hidden count renders a misleading "0 followers".
  const countData = followerCountQuery.data;
  const baseCount =
    countData && countData.isPublic ? (countData.count ?? null) : null;
  const followerCount = useMemo<number | null>(() => {
    if (baseCount === null) return null;
    // Only the viewer's own un-reconciled flip should move the count.
    if (override === null || override === serverIsFollowing) return baseCount;
    return Math.max(0, baseCount + (override ? 1 : -1));
  }, [baseCount, override, serverIsFollowing]);

  // Redirect targets the CURRENT page so completing sign-in closes the
  // overlay without navigating; the reactive session then re-enables the
  // authed follow path and the viewer presses Follow again.
  const requireSignIn = useCallback(() => {
    showSignInOverlay({ redirect: pathname || "/" });
  }, [pathname, showSignInOverlay]);

  const toggle = useCallback(() => {
    if (!hasEntity || isPending) return;

    if (!signedIn) {
      requireSignIn();
      return;
    }

    const current = override ?? serverIsFollowing;
    const next = !current;
    setOverride(next);

    const mutation = next ? followMutation : unfollowMutation;
    mutation.mutate(
      { entityPageId },
      {
        onError: (err) => {
          // Roll back only if this toggle still owns the override.
          setOverride((prev) => (prev === next ? current : prev));
          if (err.data?.code === "UNAUTHORIZED") {
            requireSignIn();
          } else {
            toast.danger({ title: String(t("account.sFollowingToggleError")) });
          }
        },
        onSuccess: () => {
          void utils.follows.listFollowedEntities.invalidate();
          void utils.follows.isFollowing.invalidate({ entityPageId });
          void utils.follows.getFollowerCount.invalidate({ entityPageId });
        },
      },
    );
  }, [
    entityPageId,
    isPending,
    toast,
    t,
    followMutation,
    hasEntity,
    override,
    requireSignIn,
    serverIsFollowing,
    signedIn,
    unfollowMutation,
    utils,
  ]);

  return {
    isFollowing,
    followerCount,
    isPending,
    canFollow: hasEntity,
    toggle,
  };
}
