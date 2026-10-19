/**
 * Classify what changed between two adjacent block-history snapshots.
 *
 * WHY THIS EXISTS: block history is not text undo. Per `useBlockHistory`, every
 * block action is its own immediately-persisted `managePageBlocks` mutation, so
 * "Undo" issues real inverse mutations against a LIVE page. A bare "Undo" is
 * therefore a misdescription — the control has to say what it is about to
 * revert. This turns a snapshot pair into the raw facts a caller needs to say
 * it ("hide 'Upcoming events'"), leaving all wording and i18n to the caller.
 *
 * Deliberately pure and React-free so the classification is unit-testable on
 * its own, away from the hook's mutation machinery.
 */

/** The snapshot shape `useBlockHistory` stores (authored data only). */
export interface HistoryBlock {
  id: string;
  kind: string;
  data: unknown;
  visible: boolean;
}

export type HistorySnapshot = readonly HistoryBlock[];

/**
 * The six real change classes, plus two the caller must handle:
 *
 * - `"mixed"` — several DIFFERENT classes in one step (e.g. an add and an
 *   edit). Naming it after any single class would be a lie, so it gets its
 *   own generic phrase.
 * - `"none"` — the snapshots are equivalent. Should not reach the UI (the hook
 *   only pushes genuine changes) but is returned rather than thrown so a
 *   degenerate pair can never crash a tooltip.
 */
export type HistoryStepKind =
  | "add"
  | "delete"
  | "edit"
  | "show"
  | "hide"
  | "reorder"
  | "mixed"
  | "none";

export interface HistoryStepDescription {
  kind: HistoryStepKind;
  /**
   * The affected block's kind, ONLY when exactly one block is affected by
   * exactly one change class. Null otherwise — the caller then uses a generic
   * phrase rather than concatenating a list.
   */
  blockKind: string | null;
  /**
   * The affected block's user-authored heading, when it has a non-empty one.
   *
   * `data.heading` is the single block-level title field in the schema: it is
   * declared once as `headingField` in
   * `packages/core/src/use-cases/entity-pages/block-config.ts` and reused by 31
   * block configs. (`block-settings-model.ts` was checked first and exposes no
   * block-level title at all — its `labelKey`s describe fields INSIDE object
   * lists, e.g. an FAQ item's `question`.)
   */
  blockTitle: string | null;
  /** True when the phrase must stay generic (many blocks, or many classes). */
  multiple: boolean;
}

/**
 * Order-insensitive stable stringify, matching `useBlockHistory`'s own
 * comparison so this classifier and the recorder never disagree about whether
 * `data` changed.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify(
          (value as Record<string, unknown>)[k],
        )}`,
    )
    .join(",")}}`;
}

/** A block's user-authored heading, trimmed, or null when it has none. */
export function readBlockTitle(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const heading = (data as Record<string, unknown>).heading;
  if (typeof heading !== "string") return null;
  const trimmed = heading.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `past_shows` → `Past Shows`. Last-resort name for a kind with no config. */
export function formatBlockKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const EMPTY: HistoryStepDescription = {
  kind: "none",
  blockKind: null,
  blockTitle: null,
  multiple: false,
};

/**
 * Describe the action that turns `from` into `to`.
 *
 * Precedence when one step touches several classes is structural → visibility
 * → content → order, but that only picks the *label* for a `multiple` step;
 * two or more distinct classes always report `kind: "mixed"`.
 */
export function describeHistoryStep(
  from: HistorySnapshot,
  to: HistorySnapshot,
): HistoryStepDescription {
  const fromById = new Map(from.map((b) => [b.id, b]));
  const toById = new Map(to.map((b) => [b.id, b]));

  const added: HistoryBlock[] = [];
  const removed: HistoryBlock[] = [];
  const edited: HistoryBlock[] = [];
  const shown: HistoryBlock[] = [];
  const hidden: HistoryBlock[] = [];

  for (const block of to) {
    if (!fromById.has(block.id)) added.push(block);
  }
  for (const block of from) {
    if (!toById.has(block.id)) removed.push(block);
  }
  for (const next of to) {
    const prev = fromById.get(next.id);
    if (!prev) continue;
    if (prev.visible !== next.visible) {
      (next.visible ? shown : hidden).push(next);
    }
    if (stableStringify(prev.data) !== stableStringify(next.data)) {
      edited.push(next);
    }
  }

  // Order only counts as a change when the SET is unchanged; otherwise the
  // add/delete already explains the sequence difference.
  let reordered = false;
  if (added.length === 0 && removed.length === 0 && from.length === to.length) {
    for (let i = 0; i < to.length; i++) {
      if (from[i]?.id !== to[i]!.id) {
        reordered = true;
        break;
      }
    }
  }

  // Structural → visibility → content → order.
  const classes: { kind: HistoryStepKind; blocks: HistoryBlock[] }[] = (
    [
      { kind: "add", blocks: added },
      { kind: "delete", blocks: removed },
      { kind: "hide", blocks: hidden },
      { kind: "show", blocks: shown },
      { kind: "edit", blocks: edited },
    ] satisfies { kind: HistoryStepKind; blocks: HistoryBlock[] }[]
  ).filter((entry) => entry.blocks.length > 0);
  if (reordered) classes.push({ kind: "reorder", blocks: [] });

  if (classes.length === 0) return EMPTY;

  if (classes.length > 1) {
    return { kind: "mixed", blockKind: null, blockTitle: null, multiple: true };
  }

  const only = classes[0]!;
  // Reorder is never about one block — it is a change to the sequence.
  if (only.kind === "reorder") {
    return {
      kind: "reorder",
      blockKind: null,
      blockTitle: null,
      multiple: true,
    };
  }
  if (only.blocks.length > 1) {
    return { kind: only.kind, blockKind: null, blockTitle: null, multiple: true };
  }

  const block = only.blocks[0]!;
  return {
    kind: only.kind,
    blockKind: block.kind,
    blockTitle: readBlockTitle(block.data),
    multiple: false,
  };
}
