import type { EmbedScope } from "@th/core/use-cases/embeds";

/**
 * Browser-side mirror of `embedScopeSchema` (@th/core `use-cases/embeds/_shared/embed-scope.ts`).
 *
 * Re-declared here rather than importing the runtime `EMBED_SCOPES` const so the
 * widget pages (which ship to third-party sites) never pull @th/core into their
 * client bundle. The `EmbedScope` TYPE import is erased at compile time.
 *
 * Drift is guarded in BOTH directions, which needs two mechanisms:
 * - `satisfies` catches a RENAMED or REMOVED scope (a value here stops being
 *   assignable to core's union).
 * - `_scopeDriftGuard` catches an ADDED scope. `satisfies` alone would NOT:
 *   a subset still satisfies the constraint, so core could add a fourth scope
 *   and this file would happily keep coercing it to "own" forever.
 */
export type { EmbedScope };

/** Matches `embedScopeSchema`'s `.default("own")`. Omit `own` from snippets. */
export const DEFAULT_EMBED_SCOPE: EmbedScope = "own";

export const EMBED_SCOPES = [
  "own",
  "venues",
  "all",
] as const satisfies readonly EmbedScope[];

/**
 * Compile-time exhaustiveness guard. If core ADDS a scope, `Exclude` stops
 * resolving to `never`, the conditional yields `never`, and this assignment
 * fails to compile — forcing whoever added it to decide what the UI does.
 * (`_`-prefixed, so the unused-vars rule allows it.)
 */
type _MissingScopes = Exclude<EmbedScope, (typeof EMBED_SCOPES)[number]>;
const _scopeDriftGuard: [_MissingScopes] extends [never] ? true : never = true;

/**
 * Coerce an untrusted `?scope=` param to a valid scope.
 *
 * Junk falls back to the default rather than throwing: a widget already pasted
 * on a live site must never white-screen because someone hand-edited the URL
 * (the server applies the same lenient default, and every scope returns only
 * PUBLISHED events, so a bad param can't leak anything either).
 */
export function parseEmbedScope(raw: string | null | undefined): EmbedScope {
  return EMBED_SCOPES.includes(raw as EmbedScope)
    ? (raw as EmbedScope)
    : DEFAULT_EMBED_SCOPE;
}
