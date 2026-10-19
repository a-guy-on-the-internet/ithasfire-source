import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { dropGripDrag, moveBlocks, type MoveDirection } from "./block-moves";

function move(editor: Editor, direction: MoveDirection): boolean {
  if (!editor.isEditable) return false;
  const tr = moveBlocks(editor.state, direction);
  // At the top or bottom the key is still consumed: letting it through
  // would extend the selection by a paragraph, which reads as a half-move.
  if (tr) editor.view.dispatch(tr);
  return true;
}

/**
 * Alt+Shift+ArrowUp / ArrowDown move the top-level block holding the
 * selection (or every block a selection spans) one place, keeping the
 * selection inside it. The grip's menu runs the same `moveBlocks`.
 */
export const BlockMove = Extension.create({
  name: "blockMove",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockMoveDrop"),
        props: {
          // A block dragged by its grip lands between top-level blocks, not
          // at ProseMirror's deepest valid drop point (inside a list item).
          handleDrop(view, event) {
            if (!dropGripDrag(view, event.clientY)) return false;
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      "Alt-Shift-ArrowUp": () => move(this.editor, "up"),
      "Alt-Shift-ArrowDown": () => move(this.editor, "down"),
    };
  },
});
