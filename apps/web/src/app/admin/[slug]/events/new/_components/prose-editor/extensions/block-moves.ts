/**
 * Reordering the description's top-level blocks: the grip's Move up / Move
 * down / Delete block, Alt+Shift+ArrowUp / ArrowDown, and the grip's drag.
 *
 * A move is ONE transaction, closed off in history, so one Ctrl+Z undoes one
 * move. It moves the NEIGHBOUR across the blocks being moved rather than the
 * blocks themselves, so the selection inside them maps along with no
 * rebuilding. It does NOT decide which DOM survives: ProseMirror's view diff
 * keeps the DOM of whichever block ends up earlier and rebuilds the other from
 * its attrs, so a media block moved down gets a fresh node view (its player
 * restarts; ProseEditor.block-gutter.test.tsx checks it comes back whole).
 */
import { Fragment } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Selection,
  TextSelection,
} from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";

export type MoveDirection = "up" | "down";

/** Transaction meta set on a move, so the gutter can announce it. */
export const BLOCK_MOVE_META = "blockMove";

/** Document position where top-level block `index` starts. */
export function topLevelStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i++) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

/** Index of the top-level block that contains (or starts at) `pos`. */
export function topLevelIndexAt(doc: PMNode, pos: number): number {
  if (doc.childCount === 0) return -1;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const index = doc.resolve(clamped).index(0);
  return Math.min(index, doc.childCount - 1);
}

/** The first and last top-level block indexes the selection touches. */
export function selectedBlockSpan(
  doc: PMNode,
  selection: Selection,
): [number, number] {
  const first = topLevelIndexAt(doc, selection.from);
  if (selection.empty || selection instanceof NodeSelection) {
    return [first, first];
  }
  const $to = selection.$to;
  // At depth 0, `to` sits on the boundary AFTER the last selected block.
  const last = $to.depth === 0 ? $to.index(0) - 1 : $to.index(0);
  return [first, Math.max(first, Math.min(last, doc.childCount - 1))];
}

/**
 * A selection inside top-level block `index`: the caret at the start of its
 * first textblock, or the block itself for media and rules.
 */
export function selectionInBlock(doc: PMNode, index: number): Selection {
  const start = topLevelStart(doc, index);
  const node = doc.child(index);
  const end = start + node.nodeSize;
  if (!node.isAtom && !node.isLeaf) {
    const inside = Selection.findFrom(doc.resolve(start + 1), 1, true);
    if (inside && inside.from < end) return inside;
  }
  return NodeSelection.create(doc, start);
}

/**
 * Move the selected top-level block(s) one place up or down, or block `at`
 * when given (the grip's menu acts on the block it sits beside, which need
 * not hold the selection; the selection moves into it). Null at the edge.
 */
export function moveBlocks(
  state: EditorState,
  direction: MoveDirection,
  at?: number,
): Transaction | null {
  const { doc } = state;
  if (doc.childCount < 2) return null;
  const tr = state.tr;
  if (at !== undefined) {
    if (at < 0 || at >= doc.childCount) return null;
    tr.setSelection(selectionInBlock(doc, at));
  }
  const [first, last] = selectedBlockSpan(doc, tr.selection);
  if (first < 0) return null;
  const start = topLevelStart(doc, first);
  const end = topLevelStart(doc, last + 1);

  if (direction === "up") {
    if (first === 0) return null;
    const above = doc.child(first - 1);
    const aboveStart = start - above.nodeSize;
    tr.delete(aboveStart, start);
    tr.insert(end - above.nodeSize, above);
  } else {
    if (last >= doc.childCount - 1) return null;
    const below = doc.child(last + 1);
    tr.delete(end, end + below.nodeSize);
    // The selection maps forward past an insertion at its block's start.
    tr.insert(start, below);
  }
  tr.setMeta(BLOCK_MOVE_META, direction).scrollIntoView();
  return closeHistory(tr);
}

/** Remove top-level block `at`; the last block left becomes an empty paragraph. */
export function deleteBlock(state: EditorState, at: number): Transaction | null {
  const { doc } = state;
  if (at < 0 || at >= doc.childCount) return null;
  const start = topLevelStart(doc, at);
  const end = start + doc.child(at).nodeSize;
  const tr = state.tr;
  if (doc.childCount === 1) {
    const paragraph = state.schema.nodes.paragraph?.create();
    if (!paragraph) return null;
    tr.replaceWith(start, end, Fragment.from(paragraph));
    tr.setSelection(TextSelection.create(tr.doc, start + 1));
  } else {
    tr.delete(start, end);
    const $pos = tr.doc.resolve(Math.min(start, tr.doc.content.size));
    tr.setSelection(Selection.near($pos, 1));
  }
  return closeHistory(tr.scrollIntoView());
}

/**
 * The grip drags in flight, per view: which block, and the `view.dragging`
 * object the drag set, so a drop can tell a grip drag from a text drag.
 */
const gripDrags = new WeakMap<
  EditorView,
  { index: number; dragging: EditorView["dragging"] }
>();

/** The block a grip drag is carrying, while that drag is still live. */
export function activeGripDrag(view: EditorView): number | null {
  const entry = gripDrags.get(view);
  if (!entry || !view.dragging || view.dragging !== entry.dragging) {
    return null;
  }
  return entry.index;
}

/** A top-level block's vertical extent, in viewport pixels. */
export type BlockRect = { top: number; bottom: number };

/**
 * Where a block dropped at viewport height `y` lands, as a top-level
 * boundary: 0 is before the first block, `rects.length` after the last.
 * Above a block's midpoint is before it. A reorder only ever lands between
 * top-level blocks, never inside a list item or a quote.
 */
export function dropBoundary(rects: readonly BlockRect[], y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (y < (rect.top + rect.bottom) / 2) return i;
  }
  return rects.length;
}

/** The viewport y of boundary `boundary`: the middle of the gap it names. */
export function boundaryY(rects: readonly BlockRect[], boundary: number): number {
  if (rects.length === 0) return 0;
  if (boundary <= 0) return rects[0]!.top;
  if (boundary >= rects.length) return rects[rects.length - 1]!.bottom;
  return (rects[boundary - 1]!.bottom + rects[boundary]!.top) / 2;
}

/** The viewport extent of every top-level block, in order. */
export function topLevelRects(view: EditorView): BlockRect[] {
  const { doc } = view.state;
  const rects: BlockRect[] = [];
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const dom = view.nodeDOM(pos);
    pos += doc.child(i).nodeSize;
    const previous = rects[rects.length - 1];
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      rects.push({ top: rect.top, bottom: rect.bottom });
    } else {
      const edge = previous?.bottom ?? 0;
      rects.push({ top: edge, bottom: edge });
    }
  }
  return rects;
}

/**
 * Move top-level block `from` to `boundary` (see `dropBoundary`) in one
 * undoable transaction, with the selection inside it. Null when the block
 * would land where it already is.
 */
export function moveBlockTo(
  state: EditorState,
  from: number,
  boundary: number,
): Transaction | null {
  const { doc } = state;
  if (from < 0 || from >= doc.childCount) return null;
  if (boundary < 0 || boundary > doc.childCount) return null;
  if (boundary === from || boundary === from + 1) return null;
  const node = doc.child(from);
  const start = topLevelStart(doc, from);
  const tr = state.tr.delete(start, start + node.nodeSize);
  tr.insert(tr.mapping.map(topLevelStart(doc, boundary)), node);
  const landed = boundary > from ? boundary - 1 : boundary;
  tr.setSelection(selectionInBlock(tr.doc, landed));
  tr.setMeta(BLOCK_MOVE_META, boundary > from ? "down" : "up");
  return closeHistory(tr.scrollIntoView());
}

/**
 * Finish a grip drag dropped at viewport height `y`: move the block to the
 * top-level boundary there and end the drag. False when no grip drag is
 * live (a text drag; ProseMirror's own drop handles it).
 */
export function dropGripDrag(view: EditorView, y: number): boolean {
  const index = activeGripDrag(view);
  if (index === null) return false;
  const boundary = dropBoundary(topLevelRects(view), y);
  const tr = moveBlockTo(view.state, index, boundary);
  // The drag is over before anything below can throw.
  view.dragging = null;
  gripDrags.delete(view);
  if (tr) view.dispatch(tr);
  view.focus();
  return true;
}

/**
 * Start a native ProseMirror drag of top-level block `index` from the grip,
 * the way ProseMirror starts one from a draggable node: select the block,
 * put its serialized slice on the DataTransfer and set `view.dragging` with
 * `move: true`, so dropping in the editor deletes the original and the drop
 * cursor shows where it lands.
 */
export function startBlockDrag(
  view: EditorView,
  index: number,
  event: DragEvent,
): boolean {
  const { dataTransfer } = event;
  const { doc } = view.state;
  if (!dataTransfer || index < 0 || index >= doc.childCount) return false;
  const start = topLevelStart(doc, index);
  const selection = NodeSelection.create(doc, start);
  view.dispatch(view.state.tr.setSelection(selection));
  const slice = selection.content();
  const { dom, text } = view.serializeForClipboard(slice);
  dataTransfer.clearData();
  dataTransfer.setData("text/html", dom.innerHTML);
  dataTransfer.setData("text/plain", text);
  dataTransfer.effectAllowed = "copyMove";
  const blockDom = view.nodeDOM(start);
  if (blockDom instanceof HTMLElement) {
    dataTransfer.setDragImage(blockDom, 0, 0);
  }
  // `node` is what ProseMirror's own dragstart records for a dragged node
  // (missing from the typings): the drop then removes exactly that block,
  // mapped through any edit made mid-drag, instead of whatever the
  // selection is when the drop lands.
  const dragging = {
    slice,
    move: true,
    node: NodeSelection.create(view.state.doc, start),
  } as EditorView["dragging"];
  view.dragging = dragging;
  // Its drop goes through `dropGripDrag` (BlockMove's handleDrop and the
  // gutter's drop), which snaps it to a top-level boundary; ProseMirror's
  // own drop would put it at the deepest valid spot, inside a list item.
  gripDrags.set(view, { index, dragging });
  return true;
}

/**
 * The grip is outside the editable DOM, so ProseMirror's own dragend never
 * sees a drag that started there and leaves `view.dragging` set when the
 * drop lands outside the editor. Clear it the way that handler does.
 */
export function endBlockDrag(view: EditorView): void {
  const dragging = view.dragging;
  window.setTimeout(() => {
    if (view.dragging === dragging) view.dragging = null;
    if (gripDrags.get(view)?.dragging === dragging) gripDrags.delete(view);
  }, 50);
}
