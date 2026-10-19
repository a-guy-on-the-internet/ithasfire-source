import libEscapeHtml from "escape-html";

const escapeHtml = (value: string) => libEscapeHtml(value);

/**
 * Sanitize and normalize rich text HTML for safe rendering.
 *
 * Contract:
 * - Input may be null/undefined/empty.
 * - Output is always a safe HTML string.
 */
export function sanitizeAndNormalizeRichTextHtml(
  input: string | null | undefined,
): string {
  if (!input) return "";

  // Keep this *very* conservative: for now we just escape HTML.
  // This ensures E2E/dev isn't blocked by unresolved optional deps.
  // If we want richer rendering later, we can re-introduce a sanitizer
  // implementation with a rock-solid bundler story.
  return escapeHtml(input);
}
