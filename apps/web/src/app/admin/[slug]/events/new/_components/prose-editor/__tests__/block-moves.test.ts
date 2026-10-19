import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  BLOCK_MOVE_META,
  activeGripDrag,
  boundaryY,
  deleteBlock,
  dropBoundary,
  dropGripDrag,
  endBlockDrag,
  moveBlockTo,
  moveBlocks,
  startBlockDrag,
  selectionInBlock,
  topLevelIndexAt,
  topLevelStart,
} from "../extensions/block-moves";
import { BlockMove } from "../extensions/BlockMove";

/**
 * Moves on a real Tiptap editor. `media` stands in for the image / audio /
 * embed blocks: an atom, draggable, block-level node with attrs, which is
 * the shape those three share. The real audio node needs the React node-view
 * renderer, which the ProseEditor component test drives.
 */
const Media = Node.create({
  name: "media",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null }, status: { default: "READY" } };
  },
  parseHTML() {
    return [{ tag: "figure[data-media]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-media": "" })];
  },
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content: string) {
  editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), Media, BlockMove],
    content,
  });
  return editor;
}

/** One-line summary of the top-level blocks. */
const blocks = () => {
  const out: string[] = [];
  editor!.state.doc.forEach((node) =>
    out.push(node.isAtom ? `[${node.attrs.src}]` : node.textContent),
  );
  return out;
};

/** Put the caret inside top-level block `index`. */
function caretIn(index: number, offset = 1) {
  const pos = topLevelStart(editor!.state.doc, index) + offset;
  editor!.view.dispatch(
    editor!.state.tr.setSelection(TextSelection.create(editor!.state.doc, pos)),
  );
}

function press(key: "ArrowUp" | "ArrowDown") {
  const view = editor!.view;
  const event = new KeyboardEvent("keydown", {
    key,
    altKey: true,
    shiftKey: true,
  });
  return !!view.someProp("handleKeyDown", (f) => f(view, event));
}

const DOC =
  "<p>one</p><p>two</p><figure data-media src=\"a.mp3\" status=\"READY\"></figure><p>four</p>";

describe("moveBlocks", () => {
  it("moves the caret's block up and keeps the caret inside it", () => {
    makeEditor(DOC);
    caretIn(1, 2); // "t|wo"
    const tr = moveBlocks(editor!.state, "up")!;
    editor!.view.dispatch(tr);
    expect(blocks()).toEqual(["two", "one", "[a.mp3]", "four"]);
    const { $from } = editor!.state.selection;
    expect($from.parent.textContent).toBe("two");
    expect($from.parentOffset).toBe(1);
    expect(tr.getMeta(BLOCK_MOVE_META)).toBe("up");
  });

  it("moves down", () => {
    makeEditor(DOC);
    caretIn(0);
    editor!.view.dispatch(moveBlocks(editor!.state, "down")!);
    expect(blocks()).toEqual(["two", "one", "[a.mp3]", "four"]);
    expect(editor!.state.selection.$from.parent.textContent).toBe("one");
  });

  it("returns null at the edges", () => {
    makeEditor(DOC);
    caretIn(0);
    expect(moveBlocks(editor!.state, "up")).toBeNull();
    caretIn(3);
    expect(moveBlocks(editor!.state, "down")).toBeNull();
    makeEditor("<p>only</p>");
    expect(moveBlocks(editor!.state, "down")).toBeNull();
  });

  it("moves an atom media block intact, attrs and selection included", () => {
    makeEditor(DOC);
    const pos = topLevelStart(editor!.state.doc, 2);
    const before = editor!.state.doc.child(2);
    editor!.view.dispatch(
      editor!.state.tr.setSelection(NodeSelection.create(editor!.state.doc, pos)),
    );
    editor!.view.dispatch(moveBlocks(editor!.state, "up")!);
    expect(blocks()).toEqual(["one", "[a.mp3]", "two", "four"]);
    const moved = editor!.state.doc.child(1);
    // The same node object: ProseMirror keeps its DOM and node view.
    expect(moved).toBe(before);
    expect(moved.attrs).toEqual({ src: "a.mp3", status: "READY" });
    const sel = editor!.state.selection;
    expect(sel).toBeInstanceOf(NodeSelection);
    expect((sel as NodeSelection).node).toBe(before);
  });

  it("moves a text block across an atom", () => {
    makeEditor(DOC);
    caretIn(3);
    editor!.view.dispatch(moveBlocks(editor!.state, "up")!);
    expect(blocks()).toEqual(["one", "two", "four", "[a.mp3]"]);
  });

  it("moves block `at` and puts the selection in it", () => {
    makeEditor(DOC);
    caretIn(0);
    editor!.view.dispatch(moveBlocks(editor!.state, "down", 2)!);
    expect(blocks()).toEqual(["one", "two", "four", "[a.mp3]"]);
    expect(editor!.state.selection).toBeInstanceOf(NodeSelection);
    expect(topLevelIndexAt(editor!.state.doc, editor!.state.selection.from)).toBe(3);
  });

  it("moves every block a selection spans", () => {
    makeEditor("<p>a</p><p>b</p><p>c</p><p>d</p>");
    const doc = editor!.state.doc;
    editor!.view.dispatch(
      editor!.state.tr.setSelection(
        TextSelection.create(doc, topLevelStart(doc, 1) + 1, topLevelStart(doc, 2) + 2),
      ),
    );
    editor!.view.dispatch(moveBlocks(editor!.state, "down")!);
    expect(blocks()).toEqual(["a", "d", "b", "c"]);
  });

  it("is undone by one undo", () => {
    makeEditor(DOC);
    caretIn(1);
    editor!.view.dispatch(moveBlocks(editor!.state, "up")!);
    editor!.view.dispatch(moveBlocks(editor!.state, "down")!);
    editor!.view.dispatch(moveBlocks(editor!.state, "down")!);
    expect(blocks()).toEqual(["one", "[a.mp3]", "two", "four"]);
    editor!.commands.undo();
    expect(blocks()).toEqual(["one", "two", "[a.mp3]", "four"]);
    editor!.commands.undo();
    expect(blocks()).toEqual(["two", "one", "[a.mp3]", "four"]);
    editor!.commands.undo();
    expect(blocks()).toEqual(["one", "two", "[a.mp3]", "four"]);
  });

  it("moves list and quote containers whole", () => {
    makeEditor("<ul><li><p>x</p></li><li><p>y</p></li></ul><blockquote><p>q</p></blockquote>");
    caretIn(1, 2);
    editor!.view.dispatch(moveBlocks(editor!.state, "up")!);
    expect(editor!.state.doc.child(0).type.name).toBe("blockquote");
    expect(editor!.state.doc.child(1).type.name).toBe("bulletList");
    expect(editor!.state.doc.child(1).childCount).toBe(2);
  });
});

describe("Alt+Shift+Arrow shortcuts", () => {
  it("move the block and consume the key, even at an edge", () => {
    makeEditor(DOC);
    caretIn(1);
    expect(press("ArrowUp")).toBe(true);
    expect(blocks()).toEqual(["two", "one", "[a.mp3]", "four"]);
    expect(press("ArrowUp")).toBe(true);
    expect(blocks()).toEqual(["two", "one", "[a.mp3]", "four"]);
    expect(press("ArrowDown")).toBe(true);
    expect(blocks()).toEqual(["one", "two", "[a.mp3]", "four"]);
  });

  it("do nothing in a read-only editor", () => {
    makeEditor(DOC);
    caretIn(1);
    editor!.setEditable(false);
    press("ArrowUp");
    expect(blocks()).toEqual(["one", "two", "[a.mp3]", "four"]);
  });
});

describe("deleteBlock", () => {
  it("removes the block in one undoable step", () => {
    makeEditor(DOC);
    editor!.view.dispatch(deleteBlock(editor!.state, 2)!);
    expect(blocks()).toEqual(["one", "two", "four"]);
    editor!.commands.undo();
    expect(blocks()).toEqual(["one", "two", "[a.mp3]", "four"]);
  });

  it("leaves an empty paragraph when it removes the last block", () => {
    makeEditor("<figure data-media src=\"x\"></figure>");
    editor!.view.dispatch(deleteBlock(editor!.state, 0)!);
    expect(editor!.state.doc.childCount).toBe(1);
    expect(editor!.state.doc.child(0).type.name).toBe("paragraph");
  });
});

describe("selectionInBlock", () => {
  it("is a caret for text, a node selection for atoms", () => {
    makeEditor(DOC);
    const doc = editor!.state.doc;
    expect(selectionInBlock(doc, 1)).toBeInstanceOf(TextSelection);
    expect(selectionInBlock(doc, 2)).toBeInstanceOf(NodeSelection);
  });
});

describe("startBlockDrag / endBlockDrag", () => {
  /** jsdom has no DataTransfer; this records what the drag puts on it. */
  function fakeDrag() {
    const data: Record<string, string> = {};
    const dataTransfer = {
      effectAllowed: "none",
      clearData: () => {
        for (const key of Object.keys(data)) delete data[key];
      },
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      setDragImage: vi.fn(),
    };
    return { event: { dataTransfer } as unknown as DragEvent, data, dataTransfer };
  }

  it("selects the block and hands ProseMirror a move of exactly that node", () => {
    makeEditor(DOC);
    const view = editor!.view;
    const { event, data, dataTransfer } = fakeDrag();
    expect(startBlockDrag(view, 2, event)).toBe(true);

    const start = topLevelStart(editor!.state.doc, 2);
    const selection = editor!.state.selection;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect(selection.from).toBe(start);
    const dragging = view.dragging as unknown as {
      move: boolean;
      node?: NodeSelection;
      slice: { content: { childCount: number } };
    };
    expect(dragging.move).toBe(true);
    expect(dragging.node?.from).toBe(start);
    expect(dragging.slice.content.childCount).toBe(1);
    expect(data["text/html"]).toContain("data-media");
    expect(dataTransfer.effectAllowed).toBe("copyMove");
  });

  it("refuses an index outside the doc", () => {
    makeEditor(DOC);
    expect(startBlockDrag(editor!.view, 9, fakeDrag().event)).toBe(false);
    expect(editor!.view.dragging).toBeNull();
  });

  it("endBlockDrag clears a drag that never dropped in the editor", () => {
    vi.useFakeTimers();
    try {
      makeEditor(DOC);
      const view = editor!.view;
      startBlockDrag(view, 0, fakeDrag().event);
      endBlockDrag(view);
      expect(view.dragging).not.toBeNull();
      vi.advanceTimersByTime(60);
      expect(view.dragging).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dropBoundary / boundaryY (grip drop snapping)", () => {
  // Three blocks, 20px tall, with 10px gaps: 0-20, 30-50, 60-80.
  const rects = [
    { top: 0, bottom: 20 },
    { top: 30, bottom: 50 },
    { top: 60, bottom: 80 },
  ];

  it("is before a block above its midpoint, after the last below it", () => {
    expect(dropBoundary(rects, -5)).toBe(0);
    expect(dropBoundary(rects, 9)).toBe(0);
    expect(dropBoundary(rects, 11)).toBe(1);
    expect(dropBoundary(rects, 25)).toBe(1);
    expect(dropBoundary(rects, 41)).toBe(2);
    expect(dropBoundary(rects, 71)).toBe(3);
    expect(dropBoundary(rects, 500)).toBe(3);
    expect(dropBoundary([], 10)).toBe(0);
  });

  it("puts the line in the middle of the gap, or on the outer edge", () => {
    expect(boundaryY(rects, 0)).toBe(0);
    expect(boundaryY(rects, 1)).toBe(25);
    expect(boundaryY(rects, 2)).toBe(55);
    expect(boundaryY(rects, 3)).toBe(80);
  });
});

describe("moveBlockTo", () => {
  const LIST_DOC = "<p>one</p><ul><li><p>item</p></li></ul><p>three</p>";

  it("lands a paragraph after a list as a top-level block, never inside it", () => {
    makeEditor(LIST_DOC);
    editor!.view.dispatch(moveBlockTo(editor!.state, 0, 2)!);
    expect(blocks()).toEqual(["item", "one", "three"]);
    const doc = editor!.state.doc;
    expect(doc.child(0).type.name).toBe("bulletList");
    expect(doc.child(0).childCount).toBe(1);
    expect(doc.child(0).child(0).childCount).toBe(1);
    expect(doc.child(1).type.name).toBe("paragraph");
    // The selection follows the block.
    expect(topLevelIndexAt(doc, editor!.state.selection.from)).toBe(1);
  });

  it("moves up, to the very end, and is one undo", () => {
    makeEditor(DOC);
    editor!.view.dispatch(moveBlockTo(editor!.state, 3, 0)!);
    expect(blocks()).toEqual(["four", "one", "two", "[a.mp3]"]);
    editor!.view.dispatch(moveBlockTo(editor!.state, 0, 4)!);
    expect(blocks()).toEqual(["one", "two", "[a.mp3]", "four"]);
    editor!.commands.undo();
    expect(blocks()).toEqual(["four", "one", "two", "[a.mp3]"]);
  });

  it("is null where the block already is, and out of range", () => {
    makeEditor(DOC);
    expect(moveBlockTo(editor!.state, 1, 1)).toBeNull();
    expect(moveBlockTo(editor!.state, 1, 2)).toBeNull();
    expect(moveBlockTo(editor!.state, 9, 0)).toBeNull();
    expect(moveBlockTo(editor!.state, 0, 9)).toBeNull();
  });

  it("tags the move for the gutter's announcement", () => {
    makeEditor(DOC);
    expect(moveBlockTo(editor!.state, 0, 3)!.getMeta(BLOCK_MOVE_META)).toBe(
      "down",
    );
    expect(moveBlockTo(editor!.state, 2, 0)!.getMeta(BLOCK_MOVE_META)).toBe(
      "up",
    );
  });
});

describe("grip drop", () => {
  function fakeDragEvent() {
    return {
      dataTransfer: {
        effectAllowed: "none",
        clearData: () => {},
        setData: () => {},
        setDragImage: () => {},
      },
    } as unknown as DragEvent;
  }

  it("BlockMove's handleDrop snaps a grip drag to a top-level boundary", () => {
    makeEditor("<p>one</p><ul><li><p>item</p></li></ul><p>three</p>");
    const view = editor!.view;
    startBlockDrag(view, 0, fakeDragEvent());
    expect(activeGripDrag(view)).toBe(0);
    // jsdom lays every block out at 0px, so any y below 0 is "after the last".
    const drop = { clientY: 10, preventDefault: vi.fn() } as unknown as DragEvent;
    const handled = view.someProp("handleDrop", (f) =>
      f(view, drop, view.dragging!.slice, true),
    );
    expect(handled).toBe(true);
    expect(blocks()).toEqual(["item", "three", "one"]);
    expect(editor!.state.doc.child(0).child(0).childCount).toBe(1);
    expect(view.dragging).toBeNull();
    expect(activeGripDrag(view)).toBeNull();
  });

  it("leaves a drag that did not start at the grip to ProseMirror", () => {
    makeEditor(DOC);
    const view = editor!.view;
    expect(dropGripDrag(view, 10)).toBe(false);
    const drop = { clientY: 10, preventDefault: vi.fn() } as unknown as DragEvent;
    expect(
      view.someProp("handleDrop", (f) =>
        f(view, drop, editor!.state.doc.slice(1, 3), true),
      ),
    ).toBeFalsy();
  });
});
