import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { NodeViewProps } from "@tiptap/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Styled-view shims and a translator, as in AudioBlockNodeView.test.tsx. The
// editor is REAL (headless TipTap with the real ImageBlock schema) so Enter's
// "leave the caption for the text after the image" is checked against an
// actual document and selection, not a stub.

vi.mock("tamagui", async () => {
  const React = await import("react");
  const DOM_PREFIX = /^(?:data-|aria-)/;
  const KEEP = new Set(["role", "title", "className", "id", "style"]);
  const forwardable = (props: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (KEEP.has(key) || DOM_PREFIX.test(key)) out[key] = value;
    }
    return out;
  };
  const Shim = React.forwardRef(
    (
      { children, ...rest }: { children?: ReactNode } & Record<string, unknown>,
      ref,
    ) => React.createElement("div", { ...forwardable(rest), ref }, children),
  );
  return {
    XStack: Shim,
    YStack: Shim,
    styled: () => Shim,
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Spinner: () => <span data-testid="spinner" />,
  // The real translator returns THE KEY on a miss, never undefined.
  useTranslations: () => (key: string) => key,
}));

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children }: { children?: ReactNode }) => (
    <div data-testid="node-view-wrapper">{children}</div>
  ),
  // ImageBlock.ts registers the node view through this; the test editor
  // below turns node views off, so it is never called.
  ReactNodeViewRenderer: () => () => ({}),
}));

import { ImageBlock } from "./ImageBlock";
import { ImageBlockNodeView } from "./ImageBlockNodeView";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(content: JSONContent[], editable = true): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    editable,
    extensions: [
      StarterKit,
      ImageBlock.extend({ addNodeView: () => null as never }),
    ],
    content: { type: "doc", content },
  });
  editors.push(editor);
  return editor;
}

const image = (attrs: Record<string, unknown> = {}) => ({
  type: "imageBlock",
  attrs: { imageId: "i1", src: "https://cdn.example/i1.jpg", ...attrs },
});

function renderImage(editor: Editor) {
  const updateAttributes = vi.fn();
  const props = {
    node: editor.state.doc.child(0),
    editor,
    selected: false,
    deleteNode: vi.fn(),
    updateAttributes,
    getPos: () => 0,
  } as unknown as NodeViewProps;
  render(<ImageBlockNodeView {...props} />);
  return { updateAttributes };
}

describe("ImageBlockNodeView caption", () => {
  it("is a labelled, length-capped single-line input under the image", () => {
    const editor = makeEditor([image({ caption: "Doors at 7" })]);
    renderImage(editor);
    const input = screen.getByTestId(
      "prose-image-caption-input",
    ) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.value).toBe("Doors at 7");
    expect(input.maxLength).toBe(200);
    expect(input.getAttribute("aria-label")).toBe("admin.ibCaptionLabel");
    expect(input.placeholder).toBe("admin.ibCaptionPlaceholder");
  });

  it("keeps the raw line while typing and stores the trimmed caption on blur", () => {
    const editor = makeEditor([image({ caption: "Old" })]);
    const { updateAttributes } = renderImage(editor);
    const input = screen.getByTestId("prose-image-caption-input");

    fireEvent.change(input, { target: { value: "" } });
    expect(updateAttributes).toHaveBeenLastCalledWith({ caption: null });

    fireEvent.change(input, { target: { value: "Doors at " } });
    expect(updateAttributes).toHaveBeenLastCalledWith({ caption: "Doors at " });

    fireEvent.blur(input, { target: { value: "  Doors   at 7  " } });
    expect(updateAttributes).toHaveBeenLastCalledWith({ caption: "Doors at 7" });
  });

  it("Enter moves the caret into the paragraph after the image", () => {
    const editor = makeEditor([
      image(),
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ]);
    renderImage(editor);
    const input = screen.getByTestId("prose-image-caption-input");

    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });
    expect(notPrevented).toBe(false);
    // Image is 1 wide; position 2 is the start of "After".
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.doc.childCount).toBe(2);
  });

  it("Enter on a trailing image adds a paragraph to land in", () => {
    const editor = makeEditor([image()]);
    renderImage(editor);

    fireEvent.keyDown(screen.getByTestId("prose-image-caption-input"), {
      key: "Enter",
    });
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.selection.from).toBe(2);
  });

  it("read-only shows the caption as text, and nothing when it is empty", () => {
    const editor = makeEditor([image({ caption: "  Doors at 7 " })], false);
    renderImage(editor);
    expect(screen.queryByTestId("prose-image-caption-input")).toBeNull();
    expect(screen.getByTestId("prose-image-caption").textContent).toBe(
      "Doors at 7",
    );
  });

  it("read-only with a blank caption renders no caption element", () => {
    const editor = makeEditor([image({ caption: "   " })], false);
    renderImage(editor);
    expect(screen.queryByTestId("prose-image-caption")).toBeNull();
    expect(screen.queryByTestId("prose-image-caption-input")).toBeNull();
  });
});
