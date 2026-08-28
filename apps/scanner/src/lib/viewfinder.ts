/**
 * Viewfinder sizing (design §1).
 *
 * The viewfinder was a fixed 220×220 (`packages/ui-native/src/styles.ts`),
 * which looks tight on an SE and lost on a 15 Pro Max. Proportional sizing
 * gives the same optical framing on every phone:
 *
 * | Device            | frame width | 0.62 × w | applied |
 * |-------------------|-------------|----------|---------|
 * | SE-class 375      | 343         | 213      | 213     |
 * | 15 Pro Max 430    | 398         | 247      | 247     |
 *
 * Clamped so a very narrow or very wide frame still gets a usable box.
 */
export const VIEWFINDER_MIN = 200;
export const VIEWFINDER_MAX = 260;
export const VIEWFINDER_RATIO = 0.62;

export function viewfinderSize(frameWidth: number): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return VIEWFINDER_MIN;
  return Math.round(
    Math.min(
      VIEWFINDER_MAX,
      Math.max(VIEWFINDER_MIN, frameWidth * VIEWFINDER_RATIO),
    ),
  );
}
