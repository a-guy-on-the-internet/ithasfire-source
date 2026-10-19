import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import {
  SlashMenu,
  pickSlashMenuItem,
  slashMenuKey,
  type SlashMenuState,
} from "../extensions/SlashMenu";
import {
  filterInsertItems,
  type InsertMenuItem,
} from "../extensions/insert-menu-items";

/**
 * The "/" menu's rules on a real Tiptap editor. Typing goes through the
 * view's `handleTextInput` the way ProseMirror's DOM reader calls it, so the
 * plugin sees exactly what a keystroke gives it.
 */
const Icon = () => null;
const item = (id: string, label: string, aliases: string[] = []) =>
  ({ id, label, aliases, icon: Icon, run: vi.fn() }) satisfies InsertMenuItem;

let editor: Editor | null = null;
let items: InsertMenuItem[] = [];

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content = "<p></p>") {
  items = [
    item("h1", "Encabezado 1", ["Heading 1", "h1", "title"]),
    item("bullet", "Lista con viñetas", ["Bulleted list", "ul"]),
    item("quote", "Cita", ["Quote", "blockquote"]),
    item("image", "Imagen", ["Image", "photo"]),
  ];
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      SlashMenu.configure({ getItems: () => items, listboxId: "lb" }),
    ],
    content,
  });
  return editor;
}

function type(text: string) {
  const view = editor!.view;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const deflt = () => view.state.tr.insertText(ch, from, to);
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, ch, deflt),
    );
    if (!handled) view.dispatch(deflt());
  }
}

function key(name: string, init: KeyboardEventInit = {}) {
  const view = editor!.view;
  const event = new KeyboardEvent("keydown", { key: name, ...init });
  const handled = view.someProp("handleKeyDown", (f) => f(view, event));
  return { handled: !!handled, event };
}

const menu = (): SlashMenuState => slashMenuKey.getState(editor!.state)!;
const text = () => editor!.state.doc.textContent;

describe("slash menu: opening", () => {
  it("opens on '/' in an empty paragraph, without changing the doc beyond the '/'", () => {
    makeEditor();
    const onUpdate = vi.fn();
    editor!.on("update", onUpdate);
    type("/");
    expect(menu()).toEqual({ active: true, from: 1, query: "", index: 0 });
    expect(text()).toBe("/");
    // Only the typed character was an edit; opening is part of it.
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("opens after leading whitespace", () => {
    makeEditor("<p>  </p>");
    editor!.commands.setTextSelection(3);
    type("/");
    expect(menu().active).toBe(true);
  });

  it("does not open mid-sentence", () => {
    makeEditor("<p>and</p>");
    editor!.commands.setTextSelection(4);
    type("/");
    expect(menu().active).toBe(false);
    expect(text()).toBe("and/");
  });

  it("does not open in a heading", () => {
    makeEditor("<h2></h2>");
    editor!.commands.setTextSelection(1);
    type("/");
    expect(menu().active).toBe(false);
  });

  it("exposes the active option to assistive tech on the editor root while open", () => {
    makeEditor();
    const dom = editor!.view.dom;
    expect(dom.hasAttribute("aria-activedescendant")).toBe(false);
    type("/");
    expect(dom.getAttribute("aria-controls")).toBe("lb");
    expect(dom.getAttribute("aria-activedescendant")).toBe("lb-opt-0");
    key("ArrowDown");
    expect(dom.getAttribute("aria-activedescendant")).toBe("lb-opt-1");
    key("Escape");
    expect(dom.hasAttribute("aria-activedescendant")).toBe(false);
    expect(dom.hasAttribute("aria-controls")).toBe(false);
  });
});

describe("slash menu: query and closing", () => {
  it("tracks the query typed after the slash and filters on it", () => {
    makeEditor();
    type("/he");
    const state = menu();
    expect(state).toMatchObject({ active: true, query: "he" });
    // Matches the English alias in a Spanish UI.
    expect(
      filterInsertItems(items, "he").map((i) => i.id),
    ).toEqual(["h1"]);
  });

  it("closes on a space and leaves the text", () => {
    makeEditor();
    type("/he ");
    expect(menu().active).toBe(false);
    expect(text()).toBe("/he ");
  });

  it("closes when nothing matches", () => {
    makeEditor();
    type("/zzz");
    expect(menu().active).toBe(false);
    expect(text()).toBe("/zzz");
  });

  it("closes when the slash is deleted", () => {
    makeEditor();
    type("/");
    editor!.commands.deleteRange({ from: 1, to: 2 });
    expect(menu().active).toBe(false);
  });

  it("closes when the caret leaves the slash range", () => {
    makeEditor("<p></p><p>next</p>");
    editor!.commands.setTextSelection(1);
    type("/");
    expect(menu().active).toBe(true);
    editor!.view.dispatch(
      editor!.state.tr.setSelection(TextSelection.create(editor!.state.doc, 6)),
    );
    expect(menu().active).toBe(false);
  });

  it("Escape closes, keeps the '/' text, and typing on does not reopen", () => {
    makeEditor();
    type("/");
    expect(key("Escape").handled).toBe(true);
    expect(menu().active).toBe(false);
    expect(text()).toBe("/");
    type("q");
    expect(menu().active).toBe(false);
  });

  it("Escape stops the event from reaching a dialog's window listener", () => {
    makeEditor();
    type("/");
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    const stop = vi.spyOn(event, "stopPropagation");
    const view = editor!.view;
    view.someProp("handleKeyDown", (f) => f(view, event));
    expect(stop).toHaveBeenCalled();
  });

  it("closes on blur", () => {
    makeEditor();
    type("/");
    const view = editor!.view;
    view.someProp("handleDOMEvents", (handlers) =>
      handlers.blur?.call(undefined as never, view, new FocusEvent("blur")),
    );
    expect(menu().active).toBe(false);
  });
});

describe("slash menu: keyboard", () => {
  it("ArrowDown / ArrowUp move the active option and wrap", () => {
    makeEditor();
    type("/");
    expect(key("ArrowDown").handled).toBe(true);
    expect(menu()).toMatchObject({ index: 1 });
    key("ArrowUp");
    key("ArrowUp");
    expect(menu()).toMatchObject({ index: items.length - 1 });
  });

  it("a new query resets the active option to the first match", () => {
    makeEditor();
    type("/");
    key("ArrowDown");
    type("c");
    expect(menu()).toMatchObject({ query: "c", index: 0 });
  });

  it("Enter deletes the '/query' text, closes, then runs the item", () => {
    makeEditor();
    type("/ci");
    const quote = items.find((i) => i.id === "quote")!;
    let textWhenRun: string | null = null;
    vi.mocked(quote.run).mockImplementation(() => {
      textWhenRun = text();
    });
    expect(key("Enter").handled).toBe(true);
    expect(quote.run).toHaveBeenCalledTimes(1);
    expect(textWhenRun).toBe("");
    expect(menu().active).toBe(false);
  });

  it("Tab picks too", () => {
    makeEditor();
    type("/");
    key("ArrowDown");
    expect(key("Tab").handled).toBe(true);
    expect(items[1]!.run).toHaveBeenCalledTimes(1);
  });

  it("leaves keys alone when closed", () => {
    makeEditor();
    const view = editor!.view;
    const own = slashMenuKey.get(view.state)!.props.handleKeyDown!;
    for (const name of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key: name });
      expect(own.call(undefined as never, view, event)).toBe(false);
    }
  });

  it("a pointer pick runs the clicked option", () => {
    makeEditor();
    type("/");
    expect(pickSlashMenuItem(editor!.view, () => items, 3)).toBe(true);
    expect(items[3]!.run).toHaveBeenCalledTimes(1);
    expect(text()).toBe("");
  });
});

describe("filterInsertItems", () => {
  it("matches label, aliases and accent-folded text, prefix matches first", () => {
    const list = [
      item("hr", "Línea horizontal", ["Divider", "hr"]),
      item("h1", "Heading 1", ["h1"]),
      item("bullet", "Bulleted list", ["ul"]),
    ];
    expect(filterInsertItems(list, "linea").map((i) => i.id)).toEqual(["hr"]);
    expect(filterInsertItems(list, "div").map((i) => i.id)).toEqual(["hr"]);
    expect(filterInsertItems(list, "h").map((i) => i.id)).toEqual(["hr", "h1"]);
    // "list" starts a word in "Bulleted list"; "st" only appears inside one.
    expect(filterInsertItems(list, "list").map((i) => i.id)).toEqual(["bullet"]);
    expect(filterInsertItems(list, "").map((i) => i.id)).toEqual([
      "hr",
      "h1",
      "bullet",
    ]);
  });
});
