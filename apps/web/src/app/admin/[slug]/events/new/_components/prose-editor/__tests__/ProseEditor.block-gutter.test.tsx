import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { topLevelIndexAt, topLevelStart } from "../extensions/block-moves";

/**
 * The block insert menu ("/" and the "+") and the block grip, on the real
 * ProseEditor and a real Tiptap editor, with Tamagui swapped for plain divs
 * and Popover rendering its children inline while open (the same shims as
 * ProseEditor.toolbar.test.tsx). Placement against real boxes, the drag and
 * the 320px fit need a browser and are checked live.
 */
vi.mock("tamagui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const isDomProp = (key: string) =>
    /^(aria-|data-)/.test(key) ||
    (/^on[A-Z]/.test(key) && key !== "onPress") ||
    ["role", "tabIndex", "className", "id", "title", "style"].includes(key);
  const Shim = ({
    ref,
    onPress,
    children,
    ...props
  }: Record<string, unknown> & {
    ref?: React.Ref<HTMLDivElement>;
    onPress?: () => void;
    children?: ReactNode;
  }) => {
    const dom: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (isDomProp(key)) dom[key] = props[key];
    }
    return (
      <div ref={ref} onClick={onPress} {...dom}>
        {children}
      </div>
    );
  };
  return { ...actual, XStack: Shim, YStack: Shim, styled: () => Shim };
});

vi.mock("@th/ui", () => {
  const Plain = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
  return {
    Text: Plain,
    Button: Plain,
    TextInput: () => <input />,
    Spinner: () => <span />,
    forms: { UploadModeToggle: () => null },
    Popover: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div data-testid="popover">{children}</div> : null,
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: { children?: ReactNode }) => (
    <div data-testid="bubble-menu">{children}</div>
  ),
}));

const { ProseEditor } = await import("../ProseEditor");

// No vi.restoreAllMocks(): it would also strip vitest.setup.ts's matchMedia
// stub, which the audio node view reads.
afterEach(() => {
  cleanup();
});

const paragraphs = (...texts: string[]) => ({
  type: "doc" as const,
  content: texts.map((text) =>
    text
      ? { type: "paragraph", content: [{ type: "text", text }] }
      : { type: "paragraph" },
  ),
});

async function renderEditor(
  props: Partial<React.ComponentProps<typeof ProseEditor>> = {},
) {
  const onChange = vi.fn();
  render(
    <ProseEditor initialContent={paragraphs("")} onChange={onChange} {...props} />,
  );
  await screen.findByRole("toolbar", { name: "admin.peToolbar" });
  const editor = (
    document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }
  ).editor;
  // ProseEditor's mount-time `setEditable` emits one update of the unchanged
  // doc (Tiptap's default); edits are counted from here.
  onChange.mockClear();
  return { editor, onChange };
}

/** Type the way ProseMirror's DOM reader hands keystrokes to plugins. */
function type(editor: Editor, text: string) {
  const view = editor.view;
  act(() => {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const deflt = () => view.state.tr.insertText(ch, from, to);
      const handled = view.someProp("handleTextInput", (f) =>
        f(view, from, to, ch, deflt),
      );
      if (!handled) view.dispatch(deflt());
    }
  });
}

/**
 * A real press: mousedown, then click. A bare click skips the mousedown the
 * editor box's click-on-padding handler reacts to, which hid a bug once.
 */
function press(el: Element) {
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

/** Focus arriving in the editor box, as a click or Tab into it gives. */
function engage(editor: Editor) {
  fireEvent.focusIn(editor.view.dom);
}

function caretIn(editor: Editor, index: number, offset = 1) {
  act(() => {
    const pos = topLevelStart(editor.state.doc, index) + offset;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
    );
  });
}

const blocks = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) =>
    out.push(node.isAtom ? `[${node.type.name}]` : node.textContent),
  );
  return out;
};

const listbox = () =>
  screen.queryByRole("listbox", { name: "admin.peInsertBlock" });
const selectedOption = () =>
  within(listbox()!).getAllByRole("option").find(
    (el) => el.getAttribute("aria-selected") === "true",
  );

describe('"/" insert menu', () => {
  it("opens on '/', walks with the arrows, and Enter turns the line into the pick", async () => {
    const { editor, onChange } = await renderEditor();
    expect(listbox()).toBeNull();

    type(editor, "/");
    expect(listbox()).not.toBeNull();
    // The editor keeps focus; the active option reaches it by id.
    const dom = editor.view.dom;
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-heading-1");
    expect(dom.getAttribute("aria-activedescendant")).toBe(selectedOption()!.id);
    expect(dom.getAttribute("aria-controls")).toBe(listbox()!.id);

    fireEvent.keyDown(dom, { key: "ArrowDown" });
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-heading-2");
    expect(dom.getAttribute("aria-activedescendant")).toBe(selectedOption()!.id);
    fireEvent.keyDown(dom, { key: "ArrowUp" });
    fireEvent.keyDown(dom, { key: "ArrowUp" });
    // Wraps to the last block on offer.
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-embed");
    fireEvent.keyDown(dom, { key: "ArrowDown" });
    fireEvent.keyDown(dom, { key: "ArrowDown" });

    fireEvent.keyDown(dom, { key: "Enter" });
    expect(listbox()).toBeNull();
    const first = editor.state.doc.child(0);
    expect(first.type.name).toBe("heading");
    expect(first.attrs.level).toBe(2);
    expect(first.textContent).toBe("");
    expect(onChange).toHaveBeenCalled();
  });

  it("filters on what follows the slash, and Escape closes it leaving the text", async () => {
    const { editor } = await renderEditor();
    type(editor, "/quo");
    expect(
      within(listbox()!).getAllByRole("option").map((el) => el.dataset.testid),
    ).toEqual(["prose-insert-option-quote"]);

    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    expect(listbox()).toBeNull();
    expect(editor.state.doc.textContent).toBe("/quo");
    expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("a click on an option picks it without moving focus out of the editor", async () => {
    const { editor } = await renderEditor();
    type(editor, "/");
    // Hovering makes an option the active one, for the keyboard too.
    fireEvent.mouseMove(screen.getByTestId("prose-insert-option-divider"));
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-divider");
    expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
      selectedOption()!.id,
    );
    const quote = screen.getByTestId("prose-insert-option-quote");
    // The mousedown is cancelled, so the editor never blurs (a blur closes it).
    expect(fireEvent.mouseDown(quote)).toBe(false);
    fireEvent.click(quote);
    expect(editor.state.doc.child(0).type.name).toBe("blockquote");
    expect(editor.state.doc.textContent).toBe("");
  });
});

describe('"+" insert button', () => {
  it("shows beside an empty line holding the caret, and showing it changes nothing", async () => {
    const { editor, onChange } = await renderEditor({
      initialContent: paragraphs("text", ""),
    });
    caretIn(editor, 1, 1);
    expect(screen.queryByTestId("prose-insert-block-btn")).toBeNull();
    engage(editor);
    const plus = screen.getByTestId("prose-insert-block-btn");
    expect(plus.getAttribute("aria-label")).toBe("admin.peInsertBlock");
    expect(plus.getAttribute("aria-haspopup")).toBe("listbox");
    expect(plus.getAttribute("aria-expanded")).toBe("false");

    // Not beside a line with text in it.
    caretIn(editor, 0, 2);
    expect(screen.queryByTestId("prose-insert-block-btn")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the list with focus in it, walks it, and Escape hands focus back to '+'", async () => {
    const { editor, onChange } = await renderEditor();
    engage(editor);
    const plus = screen.getByTestId("prose-insert-block-btn");
    press(plus);

    const list = listbox()!;
    expect(document.activeElement).toBe(list);
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    expect(plus.getAttribute("aria-controls")).toBe(list.id);
    expect(list.getAttribute("aria-activedescendant")).toBe(selectedOption()!.id);

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-heading-2");
    fireEvent.keyDown(list, { key: "End" });
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-embed");
    fireEvent.keyDown(list, { key: "Home" });
    // Type-ahead: "q" lands on Quote.
    fireEvent.keyDown(list, { key: "q" });
    expect(selectedOption()?.dataset.testid).toBe("prose-insert-option-quote");

    fireEvent.keyDown(list, { key: "Escape" });
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByTestId("prose-insert-block-btn"),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter inserts the pick in the empty line and returns focus to the editor", async () => {
    const { editor, onChange } = await renderEditor();
    engage(editor);
    press(screen.getByTestId("prose-insert-block-btn"));
    const list = listbox()!;
    // jsdom cannot focus a contenteditable, so watch the call instead.
    const focus = vi.spyOn(editor.view, "focus");
    fireEvent.keyDown(list, { key: "b" }); // Bullet List
    fireEvent.keyDown(list, { key: "Enter" });

    expect(listbox()).toBeNull();
    expect(editor.state.doc.child(0).type.name).toBe("bulletList");
    expect(onChange).toHaveBeenCalled();
    // Tiptap's focus command lands on the next frame.
    await act(() => new Promise((done) => requestAnimationFrame(done)));
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });

  it("offers only the blocks the toolbar offers this editor", async () => {
    const { editor } = await renderEditor({ showImageButton: true });
    engage(editor);
    press(screen.getByTestId("prose-insert-block-btn"));
    const ids = within(listbox()!)
      .getAllByRole("option")
      .map((el) => el.dataset.testid?.replace("prose-insert-option-", ""));
    expect(ids).toEqual([
      "heading-1",
      "heading-2",
      "heading-3",
      "bullet-list",
      "numbered-list",
      "quote",
      "divider",
      "image",
      "embed",
    ]);
  });
});

describe("block grip", () => {
  it("sits beside the selection's block, and its menu moves that block one place per pick", async () => {
    const { editor, onChange } = await renderEditor({
      initialContent: paragraphs("a", "b", "c"),
    });
    caretIn(editor, 1);
    engage(editor);
    const grip = screen.getByTestId("prose-block-grip");
    expect(grip.dataset.blockIndex).toBe("1");
    expect(grip.getAttribute("aria-haspopup")).toBe("menu");

    press(grip);
    const menu = screen.getByRole("menu", { name: "admin.peBlockHandle" });
    expect(document.activeElement).toBe(screen.getByTestId("prose-block-move-up"));
    expect(onChange).not.toHaveBeenCalled();

    press(screen.getByTestId("prose-block-move-down"));
    expect(blocks(editor)).toEqual(["a", "c", "b"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Still open, on the moved block, now at the bottom edge.
    expect(screen.getByRole("menu")).toBe(menu);
    expect(screen.getByTestId("prose-block-grip").dataset.blockIndex).toBe("2");
    expect(
      screen.getByTestId("prose-block-move-down").getAttribute("aria-disabled"),
    ).toBe("true");
    press(screen.getByTestId("prose-block-move-down"));
    expect(blocks(editor)).toEqual(["a", "c", "b"]);
    expect(screen.getByRole("status").textContent).toContain(
      "admin.peBlockMovedDown",
    );

    // One move, one undo.
    act(() => {
      editor.commands.undo();
    });
    expect(blocks(editor)).toEqual(["a", "b", "c"]);
  });

  it("walks its menu with the arrows and Escape returns focus to the grip", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    caretIn(editor, 0);
    engage(editor);
    const grip = screen.getByTestId("prose-block-grip");
    fireEvent.keyDown(grip, { key: "Enter" });
    // Move up is disabled on the first block: focus starts on Move down.
    expect(
      screen.getByTestId("prose-block-move-up").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByTestId("prose-block-move-down"),
    );
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("prose-block-delete"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("prose-block-move-up"));
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("prose-block-grip"));
  });

  it("Delete block removes the block in one undoable step", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b", "c"),
    });
    caretIn(editor, 2);
    engage(editor);
    press(screen.getByTestId("prose-block-grip"));
    press(screen.getByTestId("prose-block-delete"));
    expect(blocks(editor)).toEqual(["a", "b"]);
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      editor.commands.undo();
    });
    expect(blocks(editor)).toEqual(["a", "b", "c"]);
  });

  it("moves an audio block both ways and its player still renders", async () => {
    const { editor } = await renderEditor({
      onAudioUpload: () => Promise.resolve(null),
      initialContent: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "a" }] },
          {
            type: "audioBlock",
            attrs: { audioUploadId: "upl-1", status: "PENDING" },
          },
          { type: "paragraph", content: [{ type: "text", text: "b" }] },
        ],
      },
    });
    const player = await screen.findByTestId("audio-block");
    expect(screen.getByTestId("audio-block-skeleton")).toBeTruthy();
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(
          NodeSelection.create(
            editor.state.doc,
            topLevelStart(editor.state.doc, 1),
          ),
        ),
      );
    });
    engage(editor);
    press(screen.getByTestId("prose-block-grip"));

    // Up: the block that ends up earlier keeps its DOM, so this is the same
    // element, player state and all.
    press(screen.getByTestId("prose-block-move-up"));
    expect(blocks(editor)).toEqual(["[audioBlock]", "a", "b"]);
    expect(screen.getByTestId("audio-block")).toBe(player);

    // Down twice: ProseMirror's view diff keeps the DOM of the block that
    // ends up earlier, so the player is rebuilt from its attrs. It must come
    // back whole: one player, in its PENDING state, with the trailing empty
    // paragraph Tiptap keeps after a last non-paragraph block.
    press(screen.getByTestId("prose-block-move-down"));
    press(screen.getByTestId("prose-block-move-down"));
    expect(blocks(editor)).toEqual(["a", "b", "[audioBlock]", ""]);
    expect(screen.getAllByTestId("audio-block")).toHaveLength(1);
    expect(screen.getByTestId("audio-block").isConnected).toBe(true);
    expect(screen.getByTestId("audio-block-skeleton")).toBeTruthy();
    expect(editor.state.doc.child(2).attrs).toMatchObject({
      audioUploadId: "upl-1",
      status: "PENDING",
    });
  });
});

describe("read-only", () => {
  it("shows no '+', no grip and no '/' menu", async () => {
    const { editor } = await renderEditor({
      disabled: true,
      initialContent: paragraphs("a", ""),
    });
    caretIn(editor, 1, 1);
    engage(editor);
    expect(screen.queryByTestId("prose-gutter")).toBeNull();
    expect(screen.queryByTestId("prose-insert-block-btn")).toBeNull();
    expect(screen.queryByTestId("prose-block-grip")).toBeNull();
  });
});

describe("presses in the portalled menus stay out of the editor box", () => {
  it('"+" on a middle empty line inserts there, not at the end', async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "", "c"),
    });
    caretIn(editor, 1, 1);
    engage(editor);
    press(screen.getByTestId("prose-insert-block-btn"));
    press(screen.getByTestId("prose-insert-option-quote"));
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).textContent).toBe("a");
    expect(editor.state.doc.child(1).type.name).toBe("blockquote");
    expect(editor.state.doc.child(2).type.name).toBe("paragraph");
    expect(editor.state.doc.child(2).textContent).toBe("c");
  });

  it('"/" in a middle paragraph, then a pressed option, inserts and leaves no "/"', async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "", "c"),
    });
    caretIn(editor, 1, 1);
    type(editor, "/");
    press(screen.getByTestId("prose-insert-option-quote"));
    expect(listbox()).toBeNull();
    expect(editor.state.doc.child(1).type.name).toBe("blockquote");
    expect(editor.state.doc.textContent).toBe("ac");
  });

  it("Move down keeps focus on the entry and the selection in the moved block; Escape stops at the menu", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b", "c", "d"),
    });
    caretIn(editor, 1);
    engage(editor);
    press(screen.getByTestId("prose-block-grip"));
    const down = screen.getByTestId("prose-block-move-down");
    press(down);
    expect(blocks(editor)).toEqual(["a", "c", "b", "d"]);
    expect(document.activeElement).toBe(screen.getByTestId("prose-block-move-down"));
    expect(
      topLevelIndexAt(editor.state.doc, editor.state.selection.from),
    ).toBe(2);

    // The builder's leave-page guard listens on window.
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("prose-block-grip"));
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("the grip names its shortcuts", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    caretIn(editor, 0);
    engage(editor);
    expect(
      screen.getByTestId("prose-block-grip").getAttribute("aria-keyshortcuts"),
    ).toBe("Alt+Shift+ArrowUp Alt+Shift+ArrowDown");
  });
});

describe("editor root semantics for the '/' menu", () => {
  it("is a multi-line textbox pointing at the open menu (no aria-expanded: not allowed on a textbox)", async () => {
    const { editor } = await renderEditor();
    const dom = editor.view.dom;
    expect(dom.getAttribute("role")).toBe("textbox");
    expect(dom.getAttribute("aria-multiline")).toBe("true");
    type(editor, "/");
    expect(dom.hasAttribute("aria-expanded")).toBe(false);
    expect(dom.getAttribute("aria-autocomplete")).toBe("list");
    expect(dom.getAttribute("aria-controls")).toBe(listbox()!.id);
    expect(dom.getAttribute("aria-activedescendant")).toBe(selectedOption()!.id);
    fireEvent.keyDown(dom, { key: "Escape" });
    expect(dom.hasAttribute("aria-controls")).toBe(false);
  });
});

describe("the editor box's click-on-padding handler", () => {
  /**
   * Tamagui runs a stack's onMouseDown as onPressIn, on touchstart too, where
   * React's listener is passive and preventDefault logs a console error.
   * jsdom cannot reproduce that mapping, so the handler is called directly
   * with the event shape each input gives it.
   */
  function pressPadding(
    nativeType: "mousedown" | "touchstart",
    target: Element,
  ) {
    const box = screen.getByTestId("prose-gutter").parentElement!;
    const propsKey = Object.keys(box).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const onMouseDown = (
      box as unknown as Record<string, { onMouseDown: (e: unknown) => void }>
    )[propsKey]!.onMouseDown;
    const preventDefault = vi.fn();
    onMouseDown({
      currentTarget: box,
      target,
      nativeEvent: { type: nativeType },
      preventDefault,
    });
    return preventDefault;
  }

  /** A touch pointer event; jsdom has no PointerEvent constructor. */
  function touchPointer(
    type: "pointerdown" | "pointerup",
    target: Element,
    x: number,
    y: number,
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    Object.defineProperty(event, "pointerId", { value: 7 });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  const caretBlock = (editor: Editor) =>
    topLevelIndexAt(editor.state.doc, editor.state.selection.from);

  it("ignores touchstart entirely: no preventDefault, no caret jump", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    caretIn(editor, 0);
    const box = screen.getByTestId("prose-gutter").parentElement!;
    act(() => {
      expect(pressPadding("touchstart", box)).not.toHaveBeenCalled();
    });
    expect(caretBlock(editor)).toBe(0);
  });

  it("a mouse press on the padding puts the caret at the end", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    caretIn(editor, 0);
    const box = screen.getByTestId("prose-gutter").parentElement!;
    act(() => {
      expect(pressPadding("mousedown", box)).toHaveBeenCalled();
    });
    expect(caretBlock(editor)).toBe(1);
  });

  it("a touch TAP on the padding puts the caret at the end; a swipe does not", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    const box = screen.getByTestId("prose-gutter").parentElement!;

    caretIn(editor, 0);
    touchPointer("pointerdown", box, 10, 100);
    touchPointer("pointerup", box, 12, 160); // a scroll swipe
    expect(caretBlock(editor)).toBe(0);

    touchPointer("pointerdown", box, 10, 100);
    touchPointer("pointerup", box, 13, 104); // a tap
    expect(caretBlock(editor)).toBe(1);

    // The tap's compatibility mousedown does not run the press a 2nd time,
    // but still stops its default, which would blur the editor.
    caretIn(editor, 0);
    act(() => {
      expect(pressPadding("mousedown", box)).toHaveBeenCalled();
    });
    expect(caretBlock(editor)).toBe(0);
  });

  it("a touch tap on the text is ProseMirror's, not the padding's", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    caretIn(editor, 0);
    const text = editor.view.dom.querySelector("p")!;
    touchPointer("pointerdown", text, 10, 10);
    touchPointer("pointerup", text, 10, 10);
    expect(caretBlock(editor)).toBe(0);
  });

  it("leaves presses on the gutter's controls alone", async () => {
    const { editor } = await renderEditor({
      initialContent: paragraphs("a", "b"),
    });
    caretIn(editor, 0);
    engage(editor);
    const grip = screen.getByTestId("prose-block-grip");
    act(() => {
      expect(pressPadding("touchstart", grip)).not.toHaveBeenCalled();
      expect(pressPadding("mousedown", grip)).not.toHaveBeenCalled();
    });
    // No focus("end"): the caret stays in the first block.
    expect(
      topLevelIndexAt(editor.state.doc, editor.state.selection.from),
    ).toBe(0);
  });
});

describe("grip drag and drop", () => {
  const LIST_DOC = {
    type: "doc" as const,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "one" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "item" }] },
            ],
          },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "three" }] },
    ],
  };

  /** A DataTransfer stand-in; jsdom has none. */
  function fakeDataTransfer() {
    const data: Record<string, string> = {};
    return {
      effectAllowed: "none",
      dropEffect: "none",
      files: [] as File[],
      types: [] as string[],
      clearData: () => {
        for (const key of Object.keys(data)) delete data[key];
      },
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? "",
      setDragImage: () => {},
    };
  }

  const dropCursor = () =>
    document.querySelector(
      ".prosemirror-dropcursor-block, .prosemirror-dropcursor-inline",
    );

  /**
   * Lay the drag out the way a browser would hand it to ProseMirror: jsdom
   * has no layout, so posAtCoords points at the list (the spot ProseMirror's
   * own drop would nest into) and the drop cursor gets a parent to draw in.
   * Every block measures 0px tall, so any y > 0 is "after the last block".
   */
  async function startDrag() {
    const { editor } = await renderEditor({ initialContent: LIST_DOC });
    caretIn(editor, 0);
    engage(editor);
    const host = screen.getByTestId("prose-gutter").parentElement!;
    Object.defineProperty(editor.view.dom, "offsetParent", {
      configurable: true,
      get: () => host,
    });
    // The drop cursor redraws inline positions with coordsAtPos, which jsdom
    // cannot measure (no getClientRects).
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({
      pos: topLevelStart(editor.state.doc, 1) + 3,
      inside: -1,
    });
    const grip = screen.getByTestId("prose-block-grip");
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(grip, { dataTransfer });
    fireEvent.dragOver(editor.view.dom, { dataTransfer, clientX: 5, clientY: 10 });
    return { editor, host, grip, dataTransfer };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a drop on the text snaps to the top level and the drop cursor goes away", async () => {
    const { editor, grip, dataTransfer } = await startDrag();
    // The cursor did draw, so its absence below means something.
    expect(dropCursor()).not.toBeNull();
    vi.useFakeTimers();
    fireEvent.drop(editor.view.dom, { dataTransfer, clientX: 5, clientY: 10 });
    fireEvent.dragEnd(grip, { dataTransfer });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(blocks(editor)).toEqual(["item", "three", "one"]);
    expect(editor.state.doc.child(0).type.name).toBe("bulletList");
    expect(editor.state.doc.child(0).child(0).childCount).toBe(1);
    expect(dropCursor()).toBeNull();
    expect(editor.view.dragging).toBeNull();
  });

  it("a drop in the gutter (outside the text) is finished by the editor box", async () => {
    const { editor, host, grip, dataTransfer } = await startDrag();
    const layer = screen.getByTestId("prose-gutter");
    fireEvent.dragOver(host, { dataTransfer, clientX: 2, clientY: 10 });
    fireEvent.drop(layer, { dataTransfer, clientX: 2, clientY: 10 });
    fireEvent.dragEnd(grip, { dataTransfer });
    expect(blocks(editor)).toEqual(["item", "three", "one"]);
    expect(editor.view.dragging).toBeNull();
    expect(host.classList.contains("th-pe-grip-dragging")).toBe(false);
  });

  it("a drag whose grip unmounts is still cleared by its dragend", async () => {
    const { editor } = await startDrag();
    expect(editor.view.dragging).not.toBeNull();
    vi.useFakeTimers();
    // The grip is gone (read-only); the browser still ends the drag.
    fireEvent(window, new Event("dragend", { bubbles: true }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(editor.view.dragging).toBeNull();
  });
});
