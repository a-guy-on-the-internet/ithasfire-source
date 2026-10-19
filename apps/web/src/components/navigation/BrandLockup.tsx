"use client";

import Image from "next/image";
import { useIsDarkTheme } from "@/hooks/useIsDarkTheme";

/**
 * Theme-aware Ithas Fire lockup (flame + wordmark) for the top-left nav across
 * the consumer navbar and the seller / platform / admin shells.
 *
 * The white lockup is invisible on the light (Stub / Swiss) cream canvas, so:
 *   - Ember (dark)         → `ithasfire-lockup-white.png`
 *   - Stub / Swiss (light) → `ithasfire-lockup-black.png`
 *
 * Rendered as its own client component so it works whether the enclosing shell
 * is a client or a server component. `height` is fixed and width is `auto`
 * (both intrinsic props are set) so Next.js keeps the aspect ratio without
 * warning.
 */
export function BrandLockup({
  width,
  height,
  priority = true,
  className,
}: {
  /** Intrinsic width hint for next/image (rendered width stays `auto`). */
  width: number;
  /** Rendered + intrinsic height in px. */
  height: number;
  priority?: boolean;
  className?: string;
}) {
  const isDark = useIsDarkTheme();
  const src = isDark
    ? "/brand/ithasfire-lockup-white.png"
    : "/brand/ithasfire-lockup-black.png";

  return (
    <Image
      src={src}
      alt="Ithas Fire"
      width={width}
      height={height}
      priority={priority}
      className={className}
      // maxWidth + contain let the lockup scale down undistorted when an
      // ancestor constrains it (the mobile admin navbar's brand slot is
      // narrower than the lockup); unconstrained rendering is unchanged.
      style={{ width: "auto", height, maxWidth: "100%", objectFit: "contain" }}
    />
  );
}

BrandLockup.displayName = "BrandLockup";
