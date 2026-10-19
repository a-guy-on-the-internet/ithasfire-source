import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Fragment, Slice } from "@tiptap/pm/model";
import { undo, redo } from "@tiptap/pm/history";
import { MediaEmbed } from "../extensions/MediaEmbed";
import { PasteMediaEmbed } from "../extensions/PasteMediaEmbed";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const editors: Editor[] = [];

function makeEditor(
  content: object | string = { type: "doc", content: [{ type: "paragraph" }] },
) {
  const editor = new Editor({
    // Headless: no React node view needed to exercise the paste path.
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          protocols: ["http", "https", "mailto", "tel"],
          isAllowedUri: (url: string) => /^(https?:|mailto:|tel:)/i.test(url),
        },
      }),
      MediaEmbed.extend({ addNodeView: () => null as never }),
      PasteMediaEmbed,
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

function paste(editor: Editor, text: string, files: unknown[] = []): boolean {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  const slice = new Slice(
    Fragment.from(editor.schema.text(text.trim() || " ")),
    0,
    0,
  );
  let handled = false;
  editor.view.someProp("handlePaste", (f) => {
    handled = !!f(editor.view, event as ClipboardEvent, slice);
    return handled;
  });
  return handled;
}

const types = (e: Editor) => e.getJSON().content?.map((n) => n.type);

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

describe("PasteMediaEmbed", () => {
  it("embeds a supported URL pasted into an empty paragraph", () => {
    const editor = makeEditor();
    expect(paste(editor, YT)).toBe(true);
    expect(types(editor)).toEqual(["mediaEmbed", "paragraph"]);
    const attrs = editor.getJSON().content![0].attrs!;
    expect(attrs.provider).toBe("youtube");
    expect(attrs.sourceUrl).toContain("dQw4w9WgXcQ");
  });

  it("trims surrounding whitespace", () => {
    const editor = makeEditor();
    expect(paste(editor, `  ${YT}\n`)).toBe(true);
    expect(types(editor)).toEqual(["mediaEmbed", "paragraph"]);
  });

  it("undo turns the embed back into the linked URL, redo re-embeds", () => {
    const editor = makeEditor();
    paste(editor, YT);
    undo(editor.view.state, editor.view.dispatch);
    expect(types(editor)).toEqual(["paragraph"]);
    const text = editor.getJSON().content![0].content![0] as JSONContent;
    expect(text.text).toBe(YT);
    expect(text.marks?.[0]).toMatchObject({
      type: "link",
      attrs: { href: YT },
    });
    redo(editor.view.state, editor.view.dispatch);
    expect(types(editor)).toEqual(["mediaEmbed", "paragraph"]);
  });

  it("leaves a URL pasted mid-sentence to the default handling", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "listen: " }] },
      ],
    });
    editor.commands.focus("end");
    paste(editor, YT);
    expect(types(editor)).toEqual(["paragraph"]);
    expect(editor.getText()).toContain("listen: ");
  });

  it("leaves a URL pasted onto selected text to link-on-paste", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "pick me" }] },
      ],
    });
    editor.commands.selectAll();
    paste(editor, YT);
    expect(types(editor)).toEqual(["paragraph"]);
    const text = editor.getJSON().content![0].content![0] as JSONContent;
    expect(text.text).toBe("pick me");
    expect(text.marks?.[0]).toMatchObject({ type: "link" });
  });

  it("leaves a multi-line paste alone", () => {
    const editor = makeEditor();
    expect(paste(editor, `${YT}\nmore text`)).toBe(false);
    expect(types(editor)).toEqual(["paragraph"]);
  });

  it("does not embed a URL from an unsupported host", () => {
    const editor = makeEditor();
    expect(paste(editor, "https://example.com/some/page")).toBe(false);
    expect(types(editor)).toEqual(["paragraph"]);
  });

  it("returns false when the clipboard carries files", () => {
    const editor = makeEditor();
    expect(paste(editor, YT, [{ name: "a.png" }])).toBe(false);
    expect(types(editor)).toEqual(["paragraph"]);
  });

  it.each([
    ["list item", "<ul><li><p></p></li></ul>"],
    ["blockquote", "<blockquote><p></p></blockquote>"],
  ])("does not embed into an empty paragraph inside a %s", (_l, html) => {
    const editor = makeEditor(html);
    editor.commands.focus("start");
    expect(paste(editor, YT)).toBe(false);
    expect(editor.getHTML()).not.toContain("media-embed");
  });

  it.each([
    "https://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
  ])("embeds %s with the canonical sourceUrl", (url) => {
    const editor = makeEditor();
    expect(paste(editor, url)).toBe(true);
    const attrs = editor.getJSON().content![0].attrs!;
    expect(attrs.sourceUrl).toBe(YT);
  });

  it.each([
    "https://www.youtube.com./watch?v=dQw4w9WgXcQ",
    "https://www.youtübe.com/watch?v=dQw4w9WgXcQ",
  ])("never embeds the lookalike host %s", (url) => {
    const editor = makeEditor();
    expect(paste(editor, url)).toBe(false);
    expect(types(editor)).toEqual(["paragraph"]);
  });

  it("keeps earlier typing when undoing right after typing then pasting", () => {
    const editor = makeEditor();
    editor.commands.insertContent("Watch:");
    editor.commands.splitBlock();
    expect(paste(editor, YT)).toBe(true);
    undo(editor.view.state, editor.view.dispatch); // embed -> linked URL
    undo(editor.view.state, editor.view.dispatch); // linked URL -> empty paragraph
    expect(editor.getText()).toContain("Watch:");
    expect(editor.getText()).not.toContain("youtube");
    expect(types(editor)).toEqual(["paragraph", "paragraph"]);
  });

  it.each([
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    [
      "supported host as a subdomain prefix",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    ],
    [
      "supported host in the path",
      "https://evil.example/www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "supported host in userinfo",
      "https://www.youtube.com@evil.example/watch?v=dQw4w9WgXcQ",
    ],
    [
      "supported host in the query",
      "https://evil.example/?u=https://youtu.be/dQw4w9WgXcQ",
    ],
    [
      "credentials on a supported host",
      "https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    ["ftp scheme", "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ])("never embeds %s", (_label, url) => {
    const editor = makeEditor();
    expect(paste(editor, url)).toBe(false);
    expect(editor.getJSON().content?.some((n) => n.type === "mediaEmbed")).toBe(
      false,
    );
  });
});
