"use client";

import { useState } from "react";

import styles from "./entity-media.module.css";

/** Only treat a banner/avatar URL as usable when it is a real http(s)/data/root URL. */
export function usableImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("data:")
  ) {
    return trimmed;
  }
  return undefined;
}

/** Canonical initials derivation for every entity-page header and hero. */
export function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

type BannerProps = {
  src: string | null | undefined;
};

/**
 * Full-width header banner that renders nothing for a missing source and only
 * reveals the image once it positively loads. A blocked/failed load leaves the
 * flat base under-layer visible instead of a broken-image box (ORB-blocked
 * cross-origin images never fire `error`, so we can't rely on onError alone).
 */
export function EntityBannerImage({ src }: BannerProps) {
  const usable = usableImageUrl(src);
  const [loaded, setLoaded] = useState(false);

  if (!usable) return null;

  return (
    <div className={styles.bannerFrame}>
      <img
        src={usable}
        alt=""
        className={styles.bannerImg}
        data-loaded={loaded ? "true" : "false"}
        // A cached image can finish before React attaches onLoad, so also
        // confirm via the ref for the already-complete case.
        ref={(node) => {
          if (node?.complete && node.naturalWidth > 0) setLoaded(true);
        }}
        onLoad={(e) => {
          if (e.currentTarget.naturalWidth > 0) setLoaded(true);
        }}
        onError={() => setLoaded(false)}
      />
    </div>
  );
}

type AvatarProps = {
  src: string | null | undefined;
  /** Display name used to derive the initials fallback. */
  name: string;
};

/**
 * Fixed-size (72px) square avatar with an initials fallback. The image fades in
 * over the initials on a positive load; a blocked/missing source keeps the
 * initials visible (`onError` + a `naturalWidth` check, not just `onLoad`).
 *
 * ── Why this is NOT the shared `@th/ui` <Avatar> ─────────────────────────────
 * It is the same 72px as `<Avatar size="lg">`, so it looks substitutable. It is
 * not: this one paints from the **per-entity** theme vars
 * (`--th-color-border` / `--th-color-surface-muted` / `--th-color-text`, see
 * `entity-media.module.css`), which `buildEntityPageThemeVars` sets per page.
 * The shared Avatar paints from the global Tamagui theme (`$borderColor` /
 * `$surfaceMuted`) and cannot follow an entity's colours. Swapping it in would
 * silently drop entity theming here.
 *
 * The original comment claimed this existed because a Tamagui <Avatar> "can
 * collapse to a tiny/empty node" on these routes. That WAS true — the shared
 * Avatar's frameSize lost to the base size variant's 14px max-width clamp — but
 * it was fixed in `display/Avatar.tsx`. That is no longer a reason to keep this
 * component; the theming is.
 *
 * All three entity headers (HUMAN / ORG / PLACE) now render through this, so
 * they share one media treatment and one per-entity theme source.
 */
export function EntityAvatar({ src, name }: AvatarProps) {
  const usable = usableImageUrl(src);
  const initials = name ? getInitials(name) : "";
  const [loaded, setLoaded] = useState(false);

  return (
    <span className={styles.avatar}>
      <span className={styles.avatarInitials} aria-hidden>
        {initials || "•"}
      </span>
      {usable && (
        <img
          src={usable}
          alt=""
          className={styles.avatarImg}
          data-loaded={loaded ? "true" : "false"}
          ref={(node) => {
            if (node?.complete && node.naturalWidth > 0) setLoaded(true);
          }}
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth > 0) setLoaded(true);
          }}
          onError={() => setLoaded(false)}
        />
      )}
    </span>
  );
}
