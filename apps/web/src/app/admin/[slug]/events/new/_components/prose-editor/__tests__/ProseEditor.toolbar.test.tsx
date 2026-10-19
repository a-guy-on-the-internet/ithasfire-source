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

/**
 * The toolbar's keyboard and state wiring, on the real ProseEditor and a real
 * Tiptap editor. Tamagui is swapped for plain divs that keep only the DOM
 * props (role, aria-*, data-*, tabIndex, handlers), so what is asserted is
 * what the component itself puts on the element. Layout (row counts, the
 * fold breakpoint against real widths) needs a browser and is measured live.
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
    // The real Popover portals with Floating UI; here it only has to mount
    // its children while open, beside the trigger.
    Popover: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div data-testid="popover">{children}</div> : null,
    useTranslations: () => (key: string) => key,
  };
});

// Tiptap's menu positions itself with Floating UI, which jsdom cannot run
// (no getClientRects). What is under test is the menu's CONTENT, so it
// renders inline here, always.
vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: { children?: ReactNode }) => (
    <div data-testid="bubble-menu">{children}</div>
  ),
}));

const { ProseEditor, COMPACT_TOOLBAR_MAX_WIDTH } = await import(
  "../ProseEditor"
);

const DOC = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "plain " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.ResizeObserver = OriginalResizeObserver;
  resizeCallbacks = [];
});

/**
 * jsdom has no ResizeObserver (vitest.setup.ts installs a no-op, writable but
 * not configurable, so it is assigned rather than vi.stubGlobal'd); this one
 * fires when the test says so.
 */
const OriginalResizeObserver = window.ResizeObserver;
let resizeCallbacks: Array<() => void> = [];
function stubResizeObserver() {
  window.ResizeObserver = class {
    constructor(cb: () => void) {
      resizeCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/** Lay the editor out at `width` px; jsdom reports 0 for every box. */
let laidOutWidth = 0;
function layOutAt(width: number) {
  laidOutWidth = width;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const w = this.dataset.testid === "prose-editor" ? laidOutWidth : 0;
      return {
        width: w,
        height: 0,
        top: 0,
        left: 0,
        right: w,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

/** Resize the laid-out editor and let the observer report it. */
function resizeTo(width: number) {
  laidOutWidth = width;
  act(() => {
    for (const cb of resizeCallbacks) cb();
  });
}

async function renderEditor(
  props: Partial<React.ComponentProps<typeof ProseEditor>> = {},
) {
  render(<ProseEditor initialContent={DOC} {...props} />);
  const toolbar = await screen.findByRole("toolbar", {
    name: "admin.peToolbar",
  });
  const editor = (
    document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }
  ).editor;
  return { toolbar, editor };
}

const button = (root: HTMLElement, name: string) =>
  within(root).getByRole("button", { name, hidden: true });

const tabStops = (root: HTMLElement) =>
  within(root)
    .getAllByRole("button", { hidden: true })
    .filter((el) => el.tabIndex === 0)
    .map((el) => el.getAttribute("aria-label"));

describe("ProseEditor toolbar", () => {
  it("is one tab stop: the first enabled button, since Undo and Redo start disabled", async () => {
    const { toolbar } = await renderEditor();
    expect(button(toolbar, "admin.peUndo").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(tabStops(toolbar)).toEqual(["admin.peBold"]);
  });

  it("moves focus with Left/Right, jumps with Home/End, and the tab stop follows focus", async () => {
    const { toolbar } = await renderEditor();
    const bold = button(toolbar, "admin.peBold");
    bold.focus();
    fireEvent.keyDown(bold, { key: "ArrowRight" });
    expect(document.activeElement).toBe(button(toolbar, "admin.peItalic"));
    expect(tabStops(toolbar)).toEqual(["admin.peItalic"]);

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(
      button(toolbar, "admin.peInsertMediaEmbed"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bold); // wraps, skipping disabled Undo/Redo
    fireEvent.keyDown(bold, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(bold);
  });

  it("marks toggles with aria-pressed and leaves one-shot actions without it", async () => {
    const { toolbar } = await renderEditor();
    for (const name of [
      "admin.peBold",
      "admin.peItalic",
      "admin.peUnderline",
      "admin.peStrikethrough",
      "admin.peHighlight",
      "admin.peLink",
      "admin.peHeading1",
      "admin.peHeading2",
      "admin.peHeading3",
      "admin.peAlignLeft",
      "admin.peAlignCenter",
      "admin.peAlignRight",
      "admin.peBulletList",
      "admin.peNumberedList",
      "admin.peQuote",
    ]) {
      expect(button(toolbar, name).hasAttribute("aria-pressed")).toBe(true);
    }
    for (const name of [
      "admin.peUndo",
      "admin.peHorizontalRule",
      "admin.peClearFormatting",
    ]) {
      expect(button(toolbar, name).hasAttribute("aria-pressed")).toBe(false);
    }
  });

  it("updates aria-pressed when only the selection moves", async () => {
    const { toolbar, editor } = await renderEditor();
    const bold = button(toolbar, "admin.peBold");
    act(() => {
      editor.commands.setTextSelection(2); // inside "plain "
    });
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      editor.commands.setTextSelection(9); // inside "bold"
    });
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(bold.getAttribute("data-active")).toBe("true");
  });

  it("activates a button with Enter and with Space", async () => {
    const { toolbar, editor } = await renderEditor();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    const italic = button(toolbar, "admin.peItalic");
    act(() => {
      fireEvent.keyDown(italic, { key: "Enter" });
    });
    expect(italic.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      fireEvent.keyDown(italic, { key: " " });
    });
    expect(italic.getAttribute("aria-pressed")).toBe("false");
  });

  it("names the selection menu as its own toolbar, with pressed states and one tab stop", async () => {
    const { editor } = await renderEditor();
    act(() => {
      editor.commands.setTextSelection({ from: 8, to: 11 }); // "bold"
    });
    const menu = screen.getByRole("toolbar", {
      name: "admin.peSelectionToolbar",
    });
    expect(button(menu, "admin.peBold").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(button(menu, "admin.peItalic").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(tabStops(menu)).toEqual(["admin.peBold"]);
    const bold = button(menu, "admin.peBold");
    bold.focus();
    fireEvent.keyDown(bold, { key: "ArrowRight" });
    expect(document.activeElement).toBe(button(menu, "admin.peItalic"));
  });

  // The paste-to-embed extension lives in ./extensions; until ProseEditor
  // registers it, pasting a media URL embeds nothing at all.
  it("registers paste-to-embed beside the media embed node", async () => {
    const { editor } = await renderEditor();
    const names = editor.extensionManager.extensions.map((ext) => ext.name);
    expect(names).toEqual(
      expect.arrayContaining(["mediaEmbed", "pasteMediaEmbed"]),
    );
  });

  it("styles its content like the public event page by default", async () => {
    await renderEditor();
    expect(document.querySelector(".ProseMirror")!.className).toContain(
      "event-content-body",
    );
  });

  it("takes the caller's typography classes instead (the announcement composer's email look)", async () => {
    await renderEditor({
      typographyClassName: "event-content-body event-content-body--email",
    });
    const cls = document.querySelector(".ProseMirror")!.classList;
    expect(cls.contains("event-content-body")).toBe(true);
    expect(cls.contains("event-content-body--email")).toBe(true);
  });

  it("keeps every control inline on a wide editor, with no More button", async () => {
    layOutAt(COMPACT_TOOLBAR_MAX_WIDTH + 100);
    const { toolbar } = await renderEditor();
    expect(within(toolbar).queryByTestId("prose-more-btn")).toBeNull();
    expect(within(toolbar).getByTestId("prose-tool-strike")).toBeTruthy();
  });

  describe("narrow editor", () => {
    const FOLDED = [
      "admin.peUnderline",
      "admin.peStrikethrough",
      "admin.peHighlight",
      "admin.peHeading3",
      "admin.peAlignLeft",
      "admin.peAlignCenter",
      "admin.peAlignRight",
      "admin.peHorizontalRule",
      "admin.peClearFormatting",
    ];

    it("folds the less-used controls behind More, which stays in the roving order", async () => {
      layOutAt(206); // the editor at a 320px viewport
      const { toolbar } = await renderEditor();
      for (const name of FOLDED) {
        expect(
          within(toolbar).queryByRole("button", { name, hidden: true }),
        ).toBeNull();
      }
      const more = within(toolbar).getByTestId("prose-more-btn");
      expect(more.getAttribute("aria-expanded")).toBe("false");
      const bold = button(toolbar, "admin.peBold");
      bold.focus();
      fireEvent.keyDown(bold, { key: "End" });
      expect(document.activeElement).toBe(more);
    });

    it("opens the panel with the same buttons, moves focus in, and Escape hands focus back", async () => {
      layOutAt(206);
      const { toolbar } = await renderEditor();
      const more = within(toolbar).getByTestId("prose-more-btn");
      more.focus();
      act(() => {
        fireEvent.keyDown(more, { key: "Enter" });
      });
      expect(more.getAttribute("aria-expanded")).toBe("true");
      const panel = screen.getByTestId("prose-more-panel");
      expect(more.getAttribute("aria-controls")).toBe(panel.id);
      expect(
        within(panel)
          .getAllByRole("button", { hidden: true })
          .map((el) => el.getAttribute("aria-label")),
      ).toEqual(FOLDED);
      expect(document.activeElement).toBe(
        button(panel, "admin.peUnderline"),
      );
      expect(tabStops(panel)).toEqual(["admin.peUnderline"]);
      expect(
        button(panel, "admin.peStrikethrough").getAttribute("aria-pressed"),
      ).toBe("false");

      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(
        button(panel, "admin.peStrikethrough"),
      );

      act(() => {
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      });
      expect(screen.queryByTestId("prose-more-panel")).toBeNull();
      expect(document.activeElement).toBe(more);
      expect(more.getAttribute("aria-expanded")).toBe("false");
    });

    // Inside a Modal, focus dropping to <body> leaves the dialog's trap.
    it("widening with focus in the panel moves focus to the same tool, now inline", async () => {
      stubResizeObserver();
      layOutAt(206);
      const { toolbar } = await renderEditor();
      const more = within(toolbar).getByTestId("prose-more-btn");
      act(() => {
        fireEvent.click(more);
      });
      const panel = screen.getByTestId("prose-more-panel");
      button(panel, "admin.peHighlight").focus();
      resizeTo(COMPACT_TOOLBAR_MAX_WIDTH + 100);
      expect(screen.queryByTestId("prose-more-panel")).toBeNull();
      expect(document.activeElement).toBe(
        within(toolbar).getByTestId("prose-tool-highlight"),
      );
    });

    it("widening with focus on More moves focus to the toolbar's tab stop", async () => {
      stubResizeObserver();
      layOutAt(206);
      const { toolbar } = await renderEditor();
      within(toolbar).getByTestId("prose-more-btn").focus();
      resizeTo(COMPACT_TOOLBAR_MAX_WIDTH + 100);
      expect(document.activeElement).not.toBe(document.body);
      expect(toolbar.contains(document.activeElement)).toBe(true);
      expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
    });

    it("narrowing with focus on an inline tool that folds away moves focus to More", async () => {
      stubResizeObserver();
      layOutAt(COMPACT_TOOLBAR_MAX_WIDTH + 100);
      const { toolbar } = await renderEditor();
      within(toolbar).getByTestId("prose-tool-strike").focus();
      resizeTo(206);
      expect(document.activeElement).toBe(
        within(toolbar).getByTestId("prose-more-btn"),
      );
    });

    it("narrowing leaves focus alone on a control that stays (Bold)", async () => {
      stubResizeObserver();
      layOutAt(COMPACT_TOOLBAR_MAX_WIDTH + 100);
      const { toolbar } = await renderEditor();
      const bold = button(toolbar, "admin.peBold");
      bold.focus();
      resizeTo(206);
      expect(document.activeElement).toBe(bold);
    });

    it("runs a folded command from the panel and closes it", async () => {
      layOutAt(206);
      const { toolbar, editor } = await renderEditor();
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      act(() => {
        fireEvent.click(within(toolbar).getByTestId("prose-more-btn"));
      });
      const panel = screen.getByTestId("prose-more-panel");
      act(() => {
        fireEvent.click(button(panel, "admin.peStrikethrough"));
      });
      expect(editor.getHTML()).toContain("<s>plain</s>");
      expect(screen.queryByTestId("prose-more-panel")).toBeNull();
    });
  });
});
