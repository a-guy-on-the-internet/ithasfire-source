/**
 * Own-property lookup for copy / label tables indexed by a value that comes
 * from outside the app (a server error message or code, a query param, a
 * provider id).
 *
 * A plain object literal inherits from `Object.prototype`, so
 * `TABLE["constructor"]`, `TABLE["toString"]` and `TABLE["__proto__"]` return
 * a FUNCTION or the prototype, not `undefined`. Callers then render or
 * translate a function. This returns `undefined` for anything that is not an
 * own key of `table`.
 *
 * Use it whenever the key is `string` (not a closed union that TypeScript
 * checks). Tables keyed by a typed enum do not need it.
 */
export function lookupOwn<T>(
  table: Readonly<Record<string, T>>,
  key: string | null | undefined,
): T | undefined {
  if (typeof key !== "string") return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
