/**
 * Tokenize a free-text query into an FTS5 prefix MATCH expression.
 *
 * Returns null if the query produces no usable tokens — callers should
 * short-circuit to `[]` in that case rather than running a query that would
 * either error (empty MATCH) or match everything.
 *
 * Examples:
 *   "alice"        → "alice*"
 *   "alice ex"     → "alice* ex*"
 *   "  Bob   O'l " → "bob* o* l*"        (apostrophe is a separator)
 *   "a@b"          → "a@b*"              (email-ish chars preserved)
 *   ""             → null
 *   "   "          → null
 */
export function buildFtsMatch(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9@.+\-_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(" ");
}
