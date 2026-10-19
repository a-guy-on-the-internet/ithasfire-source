"use client";

// The class below lives in checkout.css. Imported HERE, not left to whichever
// ancestor happens to pull it in — a consumer that renders this outside the
// checkout tree would otherwise get a transparent, unanimated span and no
// error. Next dedupes the import.
import "./checkout.css";

/**
 * Animated skeleton placeholder. Reserves space so a value — or a lazily
 * loaded surface — can arrive without shifting the layout around it.
 *
 * The shimmer keyframes, the fill and the reduced-motion suppression live in
 * `checkout.css` (`.checkout-skeleton-line`). They used to be an inline
 * `<style>` emitted once PER INSTANCE, which was tolerable for a single fee
 * value and is not for the payment-card skeleton, which renders a dozen of
 * these at once.
 *
 * `aria-hidden`: a skeleton is a placeholder, not content. The surface that
 * owns the wait carries the accessible label.
 */
export const SkeletonLine = ({
  width = 60,
  height = 14,
  block = false,
}: {
  width?: number | string;
  height?: number | string;
  /** Render as a block so it can fill a row or a grid cell. */
  block?: boolean;
}) => {
  return (
    <span
      aria-hidden
      className="checkout-skeleton-line"
      style={{
        display: block ? "block" : "inline-block",
        width,
        height,
      }}
    />
  );
};
