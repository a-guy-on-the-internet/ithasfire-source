/**
 * Host-supplied labels over English defaults. Only DEFINED entries override:
 * a host passing `{ close: undefined }` (a missing catalog value, say) keeps
 * the default rather than rendering an empty control.
 */
export function mergeDefinedLabels<T extends object>(
  defaults: T,
  overrides: Partial<T> | undefined,
): T {
  const merged = { ...defaults };
  if (!overrides) return merged;
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value as T[keyof T];
  }
  return merged;
}
