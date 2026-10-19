/**
 * Entity-page editor modes.
 *
 * **The mode does NOT choose a renderer.** There is exactly one canvas — the
 * real page (`EntityPageContent`), for every layout including `"standard"`.
 * The mode selects only which CHROME each block carries on that canvas, which
 * is what keeps the editor's preview honest while the structural gate is off.
 *
 * - `"full"` — the complete per-block toolbar: drag to reorder, column span,
 *   delete (plus the Add-block palette). Requires the `entityPageEditor`
 *   feature gate to be ON **and** a freeform layout (`stack`/`grid`). This
 *   mirrors the server contract: `managePageBlocks` rejects
 *   `add`/`delete`/`reorder` with FORBIDDEN while the gate is off.
 * - `"edit-only"` — settings + hide/show only. CONTENT editing and visibility
 *   toggles are never gated (the server always allows `edit` on data/visible
 *   and `toggleVisibility`), so this is a full editing experience minus
 *   structure. The standard templates arrange blocks automatically, so
 *   structural editing would be meaningless there — and while the gate is off
 *   it is forced for every layout.
 */
export type EntityPageEditorMode = "full" | "edit-only";

export function resolveEntityPageEditorMode(args: {
  /** Resolved `entityPageEditor` feature gate. Loading/undefined = OFF. */
  editorGateOn: boolean;
  /** Effective layout key after normalization + per-owner-type default. */
  effectiveLayout: string;
}): EntityPageEditorMode {
  return args.editorGateOn && args.effectiveLayout !== "standard"
    ? "full"
    : "edit-only";
}
