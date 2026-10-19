"use client";

import { useTranslations } from "@th/ui";

import { useFollow } from "@/hooks/useFollow";
import styles from "./place-entity.module.css";

type Props = {
  /** Entity page id (on a venue page this is `page.id`). */
  entityPageId: string;
  /**
   * `primary` — filled brand CTA (hero / empty-state).
   * `compact` — same styling, tighter padding for dense rows.
   */
  variant?: "primary" | "compact";
  /** Hide the follower-count line even when a count is available. */
  showCount?: boolean;
};

/**
 * Follow / Following toggle for entity pages, backed by `useFollow`.
 *
 * - Signed-out clicks open the in-place sign-in overlay (handled in the
 *   hook), so the button always reads as an active CTA — never disabled for
 *   auth reasons.
 * - Disabled + `aria-busy` only while a follow/unfollow mutation is in flight.
 * - Optionally renders the public follower count when the page exposes one.
 */
export function FollowButton({
  entityPageId,
  variant = "primary",
  showCount = true,
}: Props) {
  const t = useTranslations();
  const { isFollowing, followerCount, isPending, canFollow, toggle } =
    useFollow(entityPageId);

  if (!canFollow) return null;

  const label = isFollowing ? t("places.following") : t("places.follow");
  const buttonClass =
    variant === "compact"
      ? `${styles.followButton} ${styles.followButtonCompact}`
      : styles.followButton;

  return (
    <span className={styles.followWrap}>
      <button
        type="button"
        className={buttonClass}
        onClick={toggle}
        disabled={isPending}
        aria-busy={isPending}
        aria-pressed={isFollowing}
        aria-label={String(label)}
        data-following={isFollowing ? "true" : "false"}
      >
        {label}
      </button>
      {showCount && followerCount != null && followerCount > 0 && (
        <span className={styles.followerCount}>
          {t("places.followerCount", { count: followerCount })}
        </span>
      )}
    </span>
  );
}
