import type { EmbedView } from "@th/core/use-cases/embeds";

/**
 * Browser-side mirror of `EMBED_VIEWS` (@th/core `use-cases/embeds/upsert-embed.ts`),
 * plus the FR-003 view-precedence resolver.
 *
 * Re-declared here rather than importing the runtime `EMBED_VIEWS` const for the
 * same reason `embed-scope.ts` re-declares the scopes: the widget pages ship to
 * third-party sites and must never pull @th/core into their client bundle. The
 * `EmbedView` TYPE import is erased at compile time.
 *
 * Drift is guarded in BOTH directions, which needs two mechanisms:
 * - `satisfies` catches a RENAMED or REMOVED view.
 * - `_viewDriftGuard` catches an ADDED view — `satisfies` alone would not,
 *   because a subset still satisfies the constraint.
 */
export type { EmbedView };

/** Matches the `Embed.defaultView` column default and the "no signal" fallback. */
export const DEFAULT_EMBED_VIEW: EmbedView = "list";

export const EMBED_VIEWS = [
  "list",
  "calendar",
] as const satisfies readonly EmbedView[];

/**
 * Compile-time exhaustiveness guard. If core ADDS a view, `Exclude` stops
 * resolving to `never`, the conditional yields `never`, and this assignment
 * fails to compile — forcing whoever added it to decide what the UI does.
 * (`_`-prefixed, so the unused-vars rule allows it.)
 */
type _MissingViews = Exclude<EmbedView, (typeof EMBED_VIEWS)[number]>;
const _viewDriftGuard: [_MissingViews] extends [never] ? true : never = true;

/**
 * Strict parse of an untrusted view string (a `?view=` param, or the bare
 * string stored in `Embed.defaultView`).
 *
 * Returns `null` — NOT the default — for anything unrecognised, because the
 * FR-003 precedence needs "unknown" to FALL THROUGH to the next signal rather
 * than short-circuit at "list". `?view=map` must land on the embed's configured
 * default, not override it.
 */
export function parseEmbedView(
  raw: string | null | undefined,
): EmbedView | null {
  return EMBED_VIEWS.includes(raw as EmbedView) ? (raw as EmbedView) : null;
}

export type ResolveEmbedViewInput = {
  /**
   * View pinned by the ROUTE itself. Only `/embed/calendar/[embedId]` sets it
   * ("calendar") — a permanent alias whose URL is a live contract on
   * third-party sites, so it wins outright and never consults `defaultView`.
   */
  routeView?: EmbedView | null;
  /** Raw `?view=` param off the widget URL. Untrusted; unknown values fall through. */
  viewParam?: string | null;
  /** `embed.defaultView` from the widget payload. A bare string; may be junk. */
  configuredDefaultView?: string | null;
};

/**
 * FR-003 / D-002 — resolve which browse view the widget renders, by fixed
 * precedence:
 *
 *   1. route pin (`/embed/calendar/…`)
 *   2. explicit `?view=list|calendar`
 *   3. the embed's stored `defaultView`
 *   4. `"list"`
 *
 * Rationale (D-002): a pasted snippet is a promise about what renders on the
 * host page, so a later admin config change must not silently swap the view
 * under a snippet that NAMED one — but it SHOULD retarget the bare canonical
 * `/embed/[id]` URL, which is exactly what a config-time default is for.
 *
 * Pure on purpose: no React, no `window`, no query client — callers pass the
 * three signals in (see `__tests__/embed-view.test.ts`).
 */
export function resolveEmbedBrowseView({
  routeView,
  viewParam,
  configuredDefaultView,
}: ResolveEmbedViewInput): EmbedView {
  return (
    routeView ??
    parseEmbedView(viewParam) ??
    parseEmbedView(configuredDefaultView) ??
    DEFAULT_EMBED_VIEW
  );
}
