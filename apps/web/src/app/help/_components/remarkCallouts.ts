import { visit } from "unist-util-visit";
import type { Root, Paragraph, PhrasingContent } from "mdast";

type CalloutKind = "tip" | "warning" | "action";

const OPEN_RE = /^:::(tip|warning|action)\s*$/;
const CLOSE_RE = /^:::\s*$/;

/**
 * Turns a fenced `:::tip … :::` block into the `<div data-callout="tip">` the
 * ArticleRenderer swaps for a {@link Callout}.
 *
 * A callout fence with no blank line inside it is ONE mdast paragraph: the
 * open line, the body and the close line arrive as text nodes with literal
 * `\n`s (or `break` nodes) between them, interleaved with whatever inline
 * markdown the body uses — `strong`, `link`, `emphasis`, `inlineCode`.
 *
 * Those inline nodes are why this rewrites the paragraph IN PLACE via
 * `data.hName` / `data.hProperties` rather than replacing it with a raw-HTML
 * node. The previous version flattened the children back into a string,
 * keeping only `text` and `break` and mapping everything else to `""` — so
 * every bolded phrase and every link inside a callout was silently DELETED,
 * not just unstyled. "Requests expire **14 days** after they're sent" shipped
 * as "Requests expire after they're sent". Re-emitting the body as raw HTML
 * wouldn't fix it either: rehype-raw parses that value as HTML, so `**14
 * days**` would render with its asterisks showing.
 *
 * Keeping the paragraph (rather than nesting a fresh one inside a raw wrapper)
 * also keeps the callout's own typography: the body inherits `Callout`'s
 * 15px/1.6, instead of picking up the article `p` override's 16px and 12px
 * margins.
 *
 * Only the single-paragraph form is handled, as before — a fence containing a
 * blank line is left alone rather than half-transformed.
 */
export const remarkCallouts = () => (tree: Root) => {
  visit(tree, "paragraph", (node: Paragraph) => {
    const children = node.children;
    if (children.length === 0) return;

    const first = children[0]!;
    if (first.type !== "text") return;

    // Open marker: the first line of the first text node, and nothing else on
    // it. `:::` can't be produced from inside a strong/link, so the markers are
    // always at the outer edges of the first and last text nodes.
    const openBreak = first.value.indexOf("\n");
    if (openBreak === -1) return;
    const openMatch = OPEN_RE.exec(first.value.slice(0, openBreak).trim());
    if (!openMatch) return;
    const kind = openMatch[1] as CalloutKind;

    const inner: PhrasingContent[] = children.slice();

    // Close marker. Two shapes, depending on how the previous line ended:
    //   "…afterwards.\n:::"        — soft break, tail of the last text node
    //   "…afterwards.", break, ":::" — hard break (line ended with two spaces)
    const lastIndex = inner.length - 1;
    const last = inner[lastIndex]!;
    if (last.type !== "text") return;

    if (CLOSE_RE.test(last.value.trim()) && lastIndex > 0) {
      // Drop the marker node, plus the break that introduced it.
      inner.pop();
      if (inner[inner.length - 1]?.type === "break") inner.pop();
      if (inner.length === 0) return;
    } else {
      const closeBreak = last.value.lastIndexOf("\n");
      if (closeBreak === -1) return;
      if (!CLOSE_RE.test(last.value.slice(closeBreak + 1).trim())) return;
      inner[lastIndex] = {
        ...last,
        value: last.value.slice(
          // Same node carries both markers when the body has no inline
          // markup at all.
          lastIndex === 0 ? openBreak + 1 : 0,
          closeBreak,
        ),
      };
    }

    if (lastIndex !== 0 || inner.length !== 1) {
      inner[0] = { ...first, value: first.value.slice(openBreak + 1) };
    }

    // Trim the blank edges the fence leaves behind, without touching the
    // interior (a body's internal newlines are the author's line wrapping).
    const head = inner[0]!;
    if (head.type === "text") {
      inner[0] = { ...head, value: head.value.replace(/^\s+/, "") };
    }
    const tail = inner[inner.length - 1]!;
    if (tail.type === "text") {
      inner[inner.length - 1] = {
        ...tail,
        value: tail.value.replace(/\s+$/, ""),
      };
    }

    node.children = inner;
    node.data = {
      ...node.data,
      hName: "div",
      hProperties: { "data-callout": kind },
    };
  });
};
