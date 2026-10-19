/**
 * Validates a custom genre tag entered by the user.
 * Accepts non-empty strings up to 50 characters containing only
 * letters, numbers, spaces, hyphens, and ampersands.
 */
export function isGenreTagAllowed(tag: string): boolean {
  if (!tag || tag.trim().length === 0) return false;
  if (tag.trim().length > 50) return false;

  const normalized = tag.trim();
  if (!/^[\p{L}\p{N}\s\-&]+$/u.test(normalized)) return false;

  return true;
}
