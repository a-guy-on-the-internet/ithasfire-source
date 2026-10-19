import { afterEach, describe, expect, it } from "vitest";
import { Editor, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { HighlightNoCarry } from "../highlight-no-carry";

/**
 * Split at the end of marked text, then type: what the new block carries.
 * Drives the commands Enter runs (`splitBlock` in a paragraph or heading,
 * `splitListItem` in a list) and a selection-relative `insertText`, which
 * applies stored marks the way typing does. Not `editor.commands.enter()`:
 * under jsdom that synthetic-keydown path drops stored marks for every mark,
 * stock bold included, so it cannot tell the fix from the bug. The real Enter
 * key is driven in the browser instead (scratchpad pw/a11y.cjs).
 */
let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function typeAfterSplit(
  highlight: AnyExtension,
  html: string,
  text = "two",
): string {
  editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), highlight],
    content: html,
  });
  const end = editor.state.doc.content.size;
  // The last text position: inside the last textblock, after its text.
  editor.commands.setTextSelection(end - (html.includes("<li>") ? 3 : 1));
  const inList = editor.isActive("listItem");
  const split = inList
    ? editor.commands.splitListItem("listItem")
    : editor.commands.splitBlock();
  expect(split).toBe(true);
  editor.view.dispatch(editor.state.tr.insertText(text));
  return editor.getHTML();
}

describe("HighlightNoCarry", () => {
  it("is not one of the marks Tiptap re-applies after a split; bold still is", () => {
    editor = new Editor({ extensions: [StarterKit, HighlightNoCarry] });
    const splittable = editor.extensionManager.splittableMarks;
    expect(splittable).not.toContain("highlight");
    expect(splittable).toEqual(expect.arrayContaining(["bold", "italic"]));
  });

  it("control: the stock extension carries the highlight into the next block (the bug)", () => {
    expect(typeAfterSplit(Highlight, "<p><mark>one</mark></p>")).toBe(
      "<p><mark>one</mark></p><p><mark>two</mark></p>",
    );
  });

  it("starts the next paragraph without the highlight", () => {
    expect(typeAfterSplit(HighlightNoCarry, "<p><mark>one</mark></p>")).toBe(
      "<p><mark>one</mark></p><p>two</p>",
    );
  });

  it("leaves a heading's highlight behind when the split starts the next block", () => {
    expect(
      typeAfterSplit(HighlightNoCarry, "<h2><mark>Lineup</mark></h2>"),
    ).toBe("<h2><mark>Lineup</mark></h2><p>two</p>");
  });

  it("starts the next list item without the highlight", () => {
    expect(
      typeAfterSplit(
        HighlightNoCarry,
        "<ul><li><p><mark>one</mark></p></li></ul>",
      ),
    ).toBe("<ul><li><p><mark>one</mark></p></li><li><p>two</p></li></ul>");
  });

  it("still carries bold, which keeps the default", () => {
    expect(
      typeAfterSplit(HighlightNoCarry, "<p><strong>one</strong></p>"),
    ).toBe("<p><strong>one</strong></p><p><strong>two</strong></p>");
  });

  it("drops only the highlight when it shares the text with bold", () => {
    expect(
      typeAfterSplit(
        HighlightNoCarry,
        "<p><strong><mark>one</mark></strong></p>",
      ),
    ).toBe("<p><strong><mark>one</mark></strong></p><p><strong>two</strong></p>");
  });
});
