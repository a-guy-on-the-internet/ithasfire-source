/**
 * Trimmed string, or null for a non-string / blank value.
 *
 * Kept in its own DEPENDENCY-FREE module: `client-ip.ts` imports it, and
 * `client-ip.ts` is bundled into the web middleware (via the staff route
 * gate), where pulling in `./utils` would drag `@trpc/server`, `zod` and
 * `@th/errors` along. `./utils` re-exports it for existing callers.
 */
export const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};
