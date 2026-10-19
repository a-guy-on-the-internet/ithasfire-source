/**
 * `width`/`height` attributes for the event poster `<img>`, or nothing.
 *
 * Under the poster CSS (`width: 100%; height: auto`, see event-content.css)
 * the attributes only feed the UA's `aspect-ratio: auto w / h`, so the browser
 * reserves the right box before the bytes arrive and the loaded render is
 * unchanged. Only a whole, positive size is trusted: half a size, a zero or a
 * fraction would reserve a wrong box, which is worse than reserving none.
 */
export function posterSizeAttrs(
  size: { width: number; height: number } | null | undefined,
): { width: number; height: number } | Record<string, never> {
  if (!size) return {};
  const { width, height } = size;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return {};
  }
  return { width, height };
}
