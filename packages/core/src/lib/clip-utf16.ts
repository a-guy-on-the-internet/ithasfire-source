/**
 * Clip text to at most `maxUnits` UTF-16 code units (what `String.length`
 * and zod's `.max()` count), never splitting a surrogate pair: when the cut
 * would leave a lone leading half, that half is dropped too. Use it wherever
 * a clipped string must pass a `z.string().max(n)` bound downstream.
 */
export function clipUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  if (maxUnits <= 0) return "";
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * {@link clipUtf16} with a trailing "…" when it cut anything; the result,
 * ellipsis included, stays within `maxUnits`.
 */
export function clipUtf16WithEllipsis(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  return `${clipUtf16(text, maxUnits - 1)}…`;
}
