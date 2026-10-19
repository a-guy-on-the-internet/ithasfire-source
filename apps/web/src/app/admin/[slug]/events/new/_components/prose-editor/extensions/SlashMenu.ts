/**
 * The "/" block menu: typing "/" at the start of a paragraph opens a list of
 * blocks to insert, filtered by what is typed after the slash.
 *
 * The plugin owns the menu's state (where the "/" is, the query, the active
 * option) so the rules are testable without React; `InsertMenu.tsx` renders
 * it. Opening, moving and closing the menu change no document content: only
 * typing the "/" (which the writer did) and picking an item edit the doc, so
 * the unsaved-changes guard and `onChange` never see the menu itself.
 *
 * The editor keeps focus the whole time. The active option reaches assistive
 * tech through `aria-activedescendant` on the editor root (the plugin's
 * `attributes` prop), the listbox pattern for a menu driven from a text field.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  filterInsertItems,
  insertOptionId,
  type InsertMenuItem,
} from "./insert-menu-items";

export type SlashMenuState =
  | { active: false }
  | {
      active: true;
      /** Position of the "/" character. */
      from: number;
      /** What follows the "/", up to the caret. */
      query: string;
      /** Index into the FILTERED items. */
      index: number;
    };

type SlashMenuMeta =
  | { type: "open"; from: number }
  | { type: "close" }
  | { type: "move"; delta: number };

export type SlashMenuOptions = {
  /** The items the toolbar offers for this editor, read on every change. */
  getItems: () => readonly InsertMenuItem[];
  /** DOM id of the rendered listbox, for aria-controls / activedescendant. */
  listboxId: string;
};

export const slashMenuKey = new PluginKey<SlashMenuState>("slashMenu");

const INACTIVE: SlashMenuState = { active: false };

/** Longer than any label: past this the writer is typing a sentence. */
const MAX_QUERY_LENGTH = 24;

/**
 * True where a typed "/" opens the menu: a paragraph whose text before the
 * caret is empty or only whitespace. Not mid-sentence ("and/or"), not in a
 * heading (it is already a block choice).
 */
export function canOpenSlashMenuAt(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.name !== "paragraph") return false;
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "￼");
  return /^\s*$/.test(before);
}

/** Re-derive the menu from the document and selection, or close it. */
function evaluate(
  state: EditorState,
  from: number,
  index: number,
  previousQuery: string | null,
  getItems: () => readonly InsertMenuItem[],
): SlashMenuState {
  const { selection, doc } = state;
  if (!selection.empty) return INACTIVE;
  const head = selection.head;
  if (from < 0 || head <= from || head > doc.content.size) return INACTIVE;
  const $from = doc.resolve(from);
  if (!$from.sameParent(selection.$head) || !$from.parent.isTextblock) {
    return INACTIVE;
  }
  const text = doc.textBetween(from, head, undefined, "￼");
  if (!text.startsWith("/")) return INACTIVE;
  const query = text.slice(1);
  // A space ends the menu: "/ " is the writer typing a slash, not a command.
  if (/\s/.test(query) || query.length > MAX_QUERY_LENGTH) return INACTIVE;
  const matches = filterInsertItems(getItems(), query).length;
  if (matches === 0) return INACTIVE;
  return {
    active: true,
    from,
    query,
    index: query === previousQuery ? Math.min(index, matches - 1) : 0,
  };
}

export function createSlashMenuPlugin(options: SlashMenuOptions): Plugin {
  const { getItems, listboxId } = options;
  return new Plugin<SlashMenuState>({
    key: slashMenuKey,
    state: {
      init: () => INACTIVE,
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(slashMenuKey) as SlashMenuMeta | undefined;
        if (meta?.type === "close") return INACTIVE;
        if (meta?.type === "open") {
          return evaluate(newState, meta.from, 0, null, getItems);
        }
        if (!prev.active) return prev;
        if (meta?.type === "move") {
          const count = filterInsertItems(getItems(), prev.query).length;
          if (count === 0) return INACTIVE;
          return {
            ...prev,
            index: (((prev.index + meta.delta) % count) + count) % count,
          };
        }
        if (!tr.docChanged && !tr.selectionSet) return prev;
        // assoc 1: text inserted right at the "/" lands before it, and the
        // "/" is still what `from` points at.
        const from = tr.mapping.map(prev.from, 1);
        return evaluate(newState, from, prev.index, prev.query, getItems);
      },
    },
    props: {
      handleTextInput(view, from, to, text, deflt) {
        if (text !== "/" || from !== to) return false;
        if (slashMenuKey.getState(view.state)?.active) return false;
        if (!canOpenSlashMenuAt(view.state, from)) return false;
        const tr = (deflt ? deflt() : view.state.tr.insertText(text, from, to))
          .setMeta(slashMenuKey, { type: "open", from } satisfies SlashMenuMeta);
        view.dispatch(tr);
        return true;
      },
      handleKeyDown(view, event) {
        const state = slashMenuKey.getState(view.state);
        if (!state?.active) return false;
        // An IME composing a character owns Enter and the arrows.
        if (event.isComposing) return false;
        if (event.altKey || event.ctrlKey || event.metaKey) return false;
        switch (event.key) {
          case "ArrowDown":
          case "ArrowUp":
            view.dispatch(
              view.state.tr.setMeta(slashMenuKey, {
                type: "move",
                delta: event.key === "ArrowDown" ? 1 : -1,
              } satisfies SlashMenuMeta),
            );
            return true;
          case "Enter":
          case "Tab":
            if (event.shiftKey) return false;
            return pickSlashMenuItem(view, getItems);
          case "Escape":
            // Leave the "/" text where it is. Stop here as well: inside the
            // announcement composer's Modal, Escape on window closes the
            // whole dialog.
            event.stopPropagation();
            closeSlashMenu(view);
            return true;
          default:
            return false;
        }
      },
      handleDOMEvents: {
        blur(view) {
          // Options are picked with a mousedown that keeps editor focus, so
          // a real blur means the writer went elsewhere.
          if (slashMenuKey.getState(view.state)?.active) closeSlashMenu(view);
          return false;
        },
      },
      attributes(state): Record<string, string> {
        // `aria-activedescendant` needs a role that supports it. Tiptap sets
        // role="textbox" only when it creates the view, and a later
        // setOptions replaces the attributes, so it is restated here.
        const base = { role: "textbox", "aria-multiline": "true" };
        const menu = slashMenuKey.getState(state);
        if (!menu?.active) return base;
        return {
          ...base,
          "aria-controls": listboxId,
          "aria-autocomplete": "list",
          "aria-activedescendant": insertOptionId(listboxId, menu.index),
        };
      },
    },
  });
}

/** Close the menu, leaving whatever was typed. */
export function closeSlashMenu(view: EditorView): void {
  view.dispatch(
    view.state.tr.setMeta(slashMenuKey, { type: "close" } satisfies SlashMenuMeta),
  );
}

/** Make filtered option `index` the active one (the pointer hovering it). */
export function setSlashMenuIndex(view: EditorView, index: number): void {
  const state = slashMenuKey.getState(view.state);
  if (!state?.active || state.index === index) return;
  view.dispatch(
    view.state.tr.setMeta(slashMenuKey, {
      type: "move",
      delta: index - state.index,
    } satisfies SlashMenuMeta),
  );
}

/**
 * Pick filtered item `index` (default: the active one): delete the "/query"
 * text and close in one transaction, then run the item's toolbar handler.
 */
export function pickSlashMenuItem(
  view: EditorView,
  getItems: () => readonly InsertMenuItem[],
  index?: number,
): boolean {
  const state = slashMenuKey.getState(view.state);
  if (!state?.active) return false;
  const item = filterInsertItems(getItems(), state.query)[index ?? state.index];
  if (!item) return false;
  const tr: Transaction = view.state.tr
    .delete(state.from, view.state.selection.head)
    .setMeta(slashMenuKey, { type: "close" } satisfies SlashMenuMeta);
  view.dispatch(tr);
  item.run();
  return true;
}

/**
 * Registers the plugin. Runs ahead of the default extensions (priority) so
 * Enter, Tab and the arrows reach the open menu before list and history
 * keymaps act on them.
 */
export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",
  priority: 1000,
  addOptions() {
    return { getItems: () => [], listboxId: "prose-insert-menu" };
  },
  addProseMirrorPlugins() {
    return [createSlashMenuPlugin(this.options)];
  },
});
