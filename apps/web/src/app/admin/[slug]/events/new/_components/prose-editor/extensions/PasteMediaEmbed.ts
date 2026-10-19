/**
 * Paste-to-embed for the description editor.
 *
 * When the clipboard holds ONLY one supported media URL (parsed by the same
 * `parseEmbedUrl` the toolbar's "Media URL" bar uses, so the paste path can
 * never embed anything the toolbar would refuse) and the cursor sits in an
 * empty top-level paragraph, the paragraph becomes a `mediaEmbed` block.
 *
 * Undo right after turns the embed back into the plain linked URL (Notion
 * style). That works with two history steps: first the URL lands as a linked
 * paragraph, then the paragraph is swapped for the embed.
 * One undo reverts only the swap.
 *
 * Everything else (URL inside text, onto a selection, several lines, files,
 * unsupported hosts) returns false so autolink / link-on-paste and the image
 * paste plugin behave as before.
 *
 * A plain-text paste (Cmd+Shift+V) also embeds, on purpose: the check reads
 * only `text/plain`.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { parseEmbedUrl } from "@th/core/lib/embeds";
import { mediaEmbedAttrsFromParsed } from "./MediaEmbed";

export const PasteMediaEmbed = Extension.create({
  name: "pasteMediaEmbed",

  // Run ahead of the default clipboard handling and the link extension's
  // paste rule.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("pasteMediaEmbed"),
        props: {
          handlePaste(view, event) {
            const data = event.clipboardData;
            if (!data || data.files?.length) return false;
            // text/uri-list is the iOS fallback when text/plain is empty.
            const trimmed = (
              data.getData("text/plain") || data.getData("text/uri-list")
            ).trim();
            // A single token: any inner whitespace means a larger paste.
            if (!trimmed || /\s/.test(trimmed)) return false;
            // The link mark only allows http(s); the embed parser agrees.
            if (!/^https?:\/\//i.test(trimmed)) return false;
            const parsed = parseEmbedUrl(trimmed);
            if (!parsed) return false;

            const { state } = view;
            const { selection, schema } = state;
            const embedType = schema.nodes.mediaEmbed;
            const paragraphType = schema.nodes.paragraph;
            const linkType = schema.marks.link;
            if (!embedType || !paragraphType || !linkType) return false;

            const { $from } = selection;
            if (
              !selection.empty ||
              $from.depth !== 1 ||
              $from.parent.type !== paragraphType ||
              $from.parent.content.size !== 0
            ) {
              return false;
            }

            const start = $from.before();
            const end = $from.after();

            // Step 1: the URL as a linked paragraph (what undo returns to).
            // closeHistory keeps this step out of the previous undo event
            // (typing right before the paste).
            const linkTr = closeHistory(state.tr).replaceWith(
              start,
              end,
              paragraphType.create(
                $from.parent.attrs,
                schema.text(trimmed, [linkType.create({ href: trimmed })]),
              ),
            );
            view.dispatch(linkTr);

            // Step 2: swap that paragraph for the embed + a trailing
            // paragraph to hold the cursor.
            // closeHistory keeps this step out of the link step's undo event.
            const swapTr = closeHistory(view.state.tr);
            const linked = swapTr.doc.resolve(start).nodeAfter;
            if (!linked) return true;
            swapTr.replaceWith(start, start + linked.nodeSize, [
              embedType.create(mediaEmbedAttrsFromParsed(parsed)),
              paragraphType.create(),
            ]);
            const cursor = start + embedType.create().nodeSize + 1;
            swapTr.setSelection(TextSelection.near(swapTr.doc.resolve(cursor)));
            view.dispatch(swapTr.scrollIntoView());

            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
